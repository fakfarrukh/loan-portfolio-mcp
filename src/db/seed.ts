import { Faker, en } from '@faker-js/faker';
import type { Database } from 'better-sqlite3';
import {
  type CustomerSegment,
  type LoanStatus,
  type LoanType,
  type PaymentStatus,
  type Region,
  type RiskGrade,
  RISK_GRADES,
} from '../schemas/domain.js';
import { DEFAULT_THRESHOLD_DAYS, DELINQUENCY_THRESHOLD_DAYS } from '../schemas/metrics.js';
import { addDays, addMonths, daysBetween, lastDayOfPreviousMonth } from './dates.js';
import { PORTFOLIO_SCHEMA_SQL } from './sqlite/schema.js';

/**
 * Deterministic synthetic data generator.
 *
 * ALL DATA IS FICTITIOUS. Names come from Faker; e-mail addresses use the reserved
 * example.com domain. The same seed and as-of date always produce the same database, which keeps
 * tests and README examples reproducible.
 *
 * Realism features:
 *  - Regional and product-level credit-quality differences (multipliers below).
 *  - A deteriorating trend over the last six months, so the trend tool has a story to tell.
 *  - A payment state machine (on time / late / missed / cure / default), from which loan status
 *    and days-past-due are *derived*, so the summary and trend metrics are mutually consistent.
 */

export interface SeedOptions {
  /** Data as-of date (YYYY-MM-DD). Defaults to the last day of the previous month. */
  asOfDate?: string;
  seed?: number;
  customers?: number;
  loans?: number;
}

export interface SeedStats {
  asOfDate: string;
  customers: number;
  loans: number;
  payments: number;
  riskRatings: number;
  delinquencyRatePct: number;
}

interface ProductSpec {
  principal: [number, number];
  baseRate: [number, number];
  terms: number[];
  riskMultiplier: number;
  payoffProbability: number;
}

const PRODUCTS: Record<LoanType, ProductSpec> = {
  mortgage: {
    principal: [140_000, 780_000],
    baseRate: [5.6, 7.1],
    terms: [360, 360, 180],
    riskMultiplier: 0.4,
    payoffProbability: 0.02,
  },
  heloc: {
    principal: [20_000, 160_000],
    baseRate: [7.6, 9.2],
    terms: [120, 180],
    riskMultiplier: 0.8,
    payoffProbability: 0.06,
  },
  auto: {
    principal: [12_000, 68_000],
    baseRate: [5.4, 9.5],
    terms: [36, 48, 60, 72],
    riskMultiplier: 1.0,
    payoffProbability: 0.1,
  },
  personal: {
    principal: [3_000, 40_000],
    baseRate: [9.5, 17.5],
    terms: [24, 36, 60],
    riskMultiplier: 1.45,
    payoffProbability: 0.12,
  },
  small_business: {
    principal: [25_000, 480_000],
    baseRate: [7.8, 12.0],
    terms: [60, 84, 120],
    riskMultiplier: 1.2,
    payoffProbability: 0.05,
  },
};

const REGION_WEIGHTS: { value: Region; weight: number; riskMultiplier: number }[] = [
  { value: 'Northeast', weight: 22, riskMultiplier: 0.85 },
  { value: 'Southeast', weight: 24, riskMultiplier: 1.55 },
  { value: 'Midwest', weight: 20, riskMultiplier: 1.0 },
  { value: 'Southwest', weight: 16, riskMultiplier: 1.3 },
  { value: 'West', weight: 18, riskMultiplier: 0.7 },
];

const GRADE_SPECS: Record<
  RiskGrade,
  { weight: number; pd: number; rateSpread: number; missProb: number }
> = {
  A: { weight: 25, pd: 0.005, rateSpread: 0.0, missProb: 0.004 },
  B: { weight: 30, pd: 0.015, rateSpread: 0.75, missProb: 0.009 },
  C: { weight: 25, pd: 0.04, rateSpread: 1.75, missProb: 0.018 },
  D: { weight: 13, pd: 0.09, rateSpread: 3.0, missProb: 0.036 },
  E: { weight: 7, pd: 0.18, rateSpread: 4.5, missProb: 0.065 },
};

/** Probability that a delinquent loan cures at the next due date, by consecutive missed payments. */
const CURE_PROBABILITY = [1, 0.5, 0.35, 0.18, 0.06];

const toCents = (usd: number): number => Math.round(usd * 100);

function amortizedPayment(principal: number, annualRatePct: number, termMonths: number): number {
  const r = annualRatePct / 100 / 12;
  return (principal * r) / (1 - Math.pow(1 + r, -termMonths));
}

function balanceAfter(
  principal: number,
  annualRatePct: number,
  payment: number,
  paymentsMade: number,
): number {
  const r = annualRatePct / 100 / 12;
  const growth = Math.pow(1 + r, paymentsMade);
  return Math.max(0, principal * growth - (payment * (growth - 1)) / r);
}

function gradeShift(grade: RiskGrade, steps: number): RiskGrade {
  const idx = Math.min(RISK_GRADES.length - 1, Math.max(0, RISK_GRADES.indexOf(grade) + steps));
  return RISK_GRADES[idx] ?? grade;
}

interface PaymentRow {
  dueDate: string;
  paidDate: string | null;
  amountDue: number;
  amountPaid: number;
  status: PaymentStatus;
  daysLate: number | null;
}

export function seedDatabase(db: Database, options: SeedOptions = {}): SeedStats {
  const asOfDate = options.asOfDate ?? lastDayOfPreviousMonth(new Date());
  const faker = new Faker({ locale: [en] });
  faker.seed(options.seed ?? 42);
  faker.setDefaultRefDate(new Date(`${asOfDate}T12:00:00Z`));

  const nCustomers = options.customers ?? 200;
  const nLoans = options.loans ?? 600;

  db.exec(PORTFOLIO_SCHEMA_SQL);

  const insertMeta = db.prepare('INSERT OR REPLACE INTO portfolio_meta (key, value) VALUES (?, ?)');
  const insertCustomer = db.prepare(
    `INSERT INTO customers (id, customer_ref, first_name, last_name, email, segment, region, customer_since)
     VALUES (@id, @ref, @first, @last, @email, @segment, @region, @since)`,
  );
  const insertLoan = db.prepare(
    `INSERT INTO loans (id, loan_ref, customer_id, loan_type, region, principal_cents, current_balance_cents,
       interest_rate, term_months, monthly_payment_cents, status, days_past_due, origination_date, maturity_date, closed_date)
     VALUES (@id, @ref, @customerId, @type, @region, @principal, @balance, @rate, @term, @payment, @status, @dpd,
       @origination, @maturity, @closed)`,
  );
  const insertPayment = db.prepare(
    `INSERT INTO payments (loan_id, due_date, paid_date, amount_due_cents, amount_paid_cents, status, days_late)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRating = db.prepare(
    `INSERT INTO risk_ratings (loan_id, rating_date, grade, probability_of_default, rated_by) VALUES (?, ?, ?, ?, ?)`,
  );

  const stats = { payments: 0, riskRatings: 0, active: 0, delinquent: 0 };

  const run = db.transaction(() => {
    insertMeta.run('as_of_date', asOfDate);
    insertMeta.run('dataset', 'synthetic');
    insertMeta.run('seed', String(options.seed ?? 42));

    // ---------------------------------------------------------------- customers
    const customers: { id: number; region: Region; segment: CustomerSegment }[] = [];
    for (let i = 1; i <= nCustomers; i++) {
      const region = faker.helpers.weightedArrayElement(REGION_WEIGHTS);
      const segment: CustomerSegment = faker.number.float() < 0.18 ? 'small_business' : 'consumer';
      const first = faker.person.firstName();
      const last = faker.person.lastName();
      insertCustomer.run({
        id: i,
        ref: `CUS-${String(i).padStart(5, '0')}`,
        first,
        last,
        email: faker.internet
          .email({ firstName: first, lastName: last, provider: 'example.com' })
          .toLowerCase(),
        segment,
        region,
        since: addDays(asOfDate, -faker.number.int({ min: 400, max: 3650 })),
      });
      customers.push({ id: i, region, segment });
    }

    // ---------------------------------------------------------------- loans
    for (let id = 1; id <= nLoans; id++) {
      const customer = faker.helpers.arrayElement(customers);
      const region = customer.region;
      const regionRisk = REGION_WEIGHTS.find((r) => r.value === region)?.riskMultiplier ?? 1;

      const type: LoanType =
        customer.segment === 'small_business' && faker.number.float() < 0.75
          ? 'small_business'
          : faker.helpers.weightedArrayElement<LoanType>([
              { value: 'mortgage', weight: 22 },
              { value: 'heloc', weight: 10 },
              { value: 'auto', weight: 32 },
              { value: 'personal', weight: 36 },
            ]);
      const product = PRODUCTS[type];

      const grade = faker.helpers.weightedArrayElement(
        RISK_GRADES.map((g) => ({ value: g, weight: GRADE_SPECS[g].weight })),
      );
      const gradeSpec = GRADE_SPECS[grade];

      const principal =
        Math.round(
          Math.exp(
            faker.number.float({
              min: Math.log(product.principal[0]),
              max: Math.log(product.principal[1]),
            }),
          ) / 100,
        ) * 100;
      const rate =
        Math.round(
          (faker.number.float({ min: product.baseRate[0], max: product.baseRate[1] }) +
            gradeSpec.rateSpread) *
            1000,
        ) / 1000;
      const term = faker.helpers.arrayElement(product.terms);
      const payment = amortizedPayment(principal, rate, term);

      // Growing portfolio: originations skew toward recent months (1–20 months before as-of).
      const monthsBack = Math.floor(20 * Math.pow(faker.number.float(), 1.35)) + 1;
      const origination = addDays(
        addMonths(asOfDate, -monthsBack),
        -faker.number.int({ min: 0, max: 25 }),
      );

      // ---- payment simulation
      const payments: PaymentRow[] = [];
      let streak = 0; // consecutive unpaid scheduled payments
      let paymentsMade = 0;
      let closedDate: string | null = null;
      const willPayOff = faker.number.float() < product.payoffProbability;

      for (let k = 1; k <= term; k++) {
        const due = addMonths(origination, k);
        if (due > asOfDate) break;

        const monthsAgo = Math.floor(daysBetween(due, asOfDate) / 30.4);
        const trend = monthsAgo < 6 ? 1 + (6 - monthsAgo) * 0.12 : 1;
        const missProb = Math.min(
          0.6,
          gradeSpec.missProb * regionRisk * product.riskMultiplier * trend,
        );
        const amountDue = payment;

        if (streak === 0) {
          if (willPayOff && k >= 4 && faker.number.float() < 0.15) {
            const payoffAmount = balanceAfter(principal, rate, payment, paymentsMade) + payment;
            payments.push({
              dueDate: due,
              paidDate: due,
              amountDue,
              amountPaid: payoffAmount,
              status: 'paid_on_time',
              daysLate: 0,
            });
            paymentsMade++;
            closedDate = due;
            break;
          }
          const roll = faker.number.float();
          if (roll < missProb) {
            payments.push({
              dueDate: due,
              paidDate: null,
              amountDue,
              amountPaid: 0,
              status: 'missed',
              daysLate: null,
            });
            streak = 1;
          } else if (roll < missProb * 2.5) {
            const late = faker.number.int({ min: 5, max: 25 });
            const paid = addDays(due, late);
            if (paid <= asOfDate) {
              payments.push({
                dueDate: due,
                paidDate: paid,
                amountDue,
                amountPaid: amountDue,
                status: 'paid_late',
                daysLate: late,
              });
              paymentsMade++;
            } else {
              payments.push({
                dueDate: due,
                paidDate: null,
                amountDue,
                amountPaid: 0,
                status: 'missed',
                daysLate: null,
              });
              streak = 1;
            }
          } else {
            payments.push({
              dueDate: due,
              paidDate: due,
              amountDue,
              amountPaid: amountDue,
              status: 'paid_on_time',
              daysLate: 0,
            });
            paymentsMade++;
          }
          continue;
        }

        // Currently delinquent: either cure (pay everything owed) or miss again.
        const cureP =
          (CURE_PROBABILITY[Math.min(streak, CURE_PROBABILITY.length - 1)] ?? 0.05) /
          Math.sqrt(trend);
        const cureDate = addDays(due, faker.number.int({ min: 0, max: 10 }));
        if (faker.number.float() < cureP && cureDate <= asOfDate) {
          for (const p of payments) {
            if (p.paidDate === null) {
              p.paidDate = cureDate;
              p.amountPaid = p.amountDue;
              p.status = 'paid_late';
              p.daysLate = daysBetween(p.dueDate, cureDate);
              paymentsMade++;
            }
          }
          payments.push({
            dueDate: due,
            paidDate: cureDate,
            amountDue,
            amountPaid: amountDue,
            status: 'paid_late',
            daysLate: daysBetween(due, cureDate),
          });
          paymentsMade++;
          streak = 0;
        } else {
          payments.push({
            dueDate: due,
            paidDate: null,
            amountDue,
            amountPaid: 0,
            status: 'missed',
            daysLate: null,
          });
          streak++;
        }
      }

      // ---- derive status from payment history (same rule the metrics use)
      const oldestUnpaid = payments.find((p) => p.paidDate === null);
      const dpd = oldestUnpaid ? daysBetween(oldestUnpaid.dueDate, asOfDate) : 0;
      let status: LoanStatus;
      if (closedDate) status = 'paid_off';
      else if (dpd >= DEFAULT_THRESHOLD_DAYS) status = 'default';
      else if (dpd >= DELINQUENCY_THRESHOLD_DAYS) status = 'delinquent';
      else status = 'current';

      const balance = closedDate ? 0 : balanceAfter(principal, rate, payment, paymentsMade);

      insertLoan.run({
        id,
        ref: `LN-${String(id).padStart(6, '0')}`,
        customerId: customer.id,
        type,
        region,
        principal: toCents(principal),
        balance: toCents(balance),
        rate,
        term,
        payment: toCents(payment),
        status,
        dpd,
        origination,
        maturity: addMonths(origination, term),
        closed: closedDate,
      });
      for (const p of payments) {
        insertPayment.run(
          id,
          p.dueDate,
          p.paidDate,
          toCents(p.amountDue),
          toCents(p.amountPaid),
          p.status,
          p.daysLate,
        );
      }
      stats.payments += payments.length;

      // ---- risk ratings: at origination, semi-annual reviews, and an analyst review if troubled
      const pdFor = (g: RiskGrade): number =>
        Math.round(GRADE_SPECS[g].pd * faker.number.float({ min: 0.8, max: 1.25 }) * 10_000) /
        10_000;
      insertRating.run(id, origination, grade, pdFor(grade), 'origination-scorecard-v3');
      stats.riskRatings++;
      let currentGrade = grade;
      for (let m = 6; addMonths(origination, m) <= (closedDate ?? asOfDate); m += 6) {
        const reviewDate = addMonths(origination, m);
        const troubled = payments.some(
          (p) =>
            p.dueDate <= reviewDate &&
            p.status !== 'paid_on_time' &&
            (p.paidDate === null || p.paidDate > reviewDate),
        );
        currentGrade = troubled
          ? gradeShift(currentGrade, 1)
          : faker.number.float() < 0.15
            ? gradeShift(currentGrade, -1)
            : currentGrade;
        insertRating.run(id, reviewDate, currentGrade, pdFor(currentGrade), 'behavioural-model-v2');
        stats.riskRatings++;
      }
      if (status === 'delinquent' || status === 'default') {
        const downgraded = gradeShift(currentGrade, status === 'default' ? 2 : 1);
        insertRating.run(
          id,
          addDays(asOfDate, -faker.number.int({ min: 1, max: 14 })),
          downgraded,
          pdFor(downgraded),
          'credit-analyst-review',
        );
        stats.riskRatings++;
      }

      if (status !== 'paid_off') {
        stats.active++;
        if (status === 'delinquent' || status === 'default') stats.delinquent++;
      }
    }
  });
  run();

  return {
    asOfDate,
    customers: nCustomers,
    loans: nLoans,
    payments: stats.payments,
    riskRatings: stats.riskRatings,
    delinquencyRatePct: Math.round((stats.delinquent / Math.max(1, stats.active)) * 10_000) / 100,
  };
}
