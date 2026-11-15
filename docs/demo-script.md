# 90-second demo script

A screen-recorded walkthrough of the loan portfolio MCP server in Claude Desktop. It shows four
things: masked names for an analyst, full names for an admin, a rejected invalid input, and the
audit log that recorded all of it.

All data is synthetic. Numbers below assume `npm run seed:demo` (as of 31 October 2026).

## Before you record

1. Build and seed with the fixed date:

   ```bash
   npm ci && npm run build && npm run seed:demo
   ```

2. Optional: start with an empty audit log, so the final scene only shows this demo.
   Delete `data/audit.db` (and `audit.db-wal` / `audit.db-shm` if present).

3. Add **two** server entries to the Claude Desktop config, using the same path from the README's
   step 2. They differ only in role and user name, so the audit log shows two different people:

   ```json
   {
     "mcpServers": {
       "loans-analyst": {
         "command": "node",
         "args": ["/full/path/to/loan-portfolio-mcp/dist/index.js"],
         "env": {
           "STDIO_ROLE": "analyst",
           "STDIO_SUBJECT": "analyst-demo",
           "LOG_LEVEL": "warn",
           "OTEL_TRACES_EXPORTER": "none"
         }
       },
       "loans-admin": {
         "command": "node",
         "args": ["/full/path/to/loan-portfolio-mcp/dist/index.js"],
         "env": {
           "STDIO_ROLE": "admin",
           "STDIO_SUBJECT": "admin-demo",
           "LOG_LEVEL": "warn",
           "OTEL_TRACES_EXPORTER": "none"
         }
       }
     }
   }
   ```

4. Restart Claude Desktop. Turn **off** `loans-admin` in Claude Desktop's tool settings, so only
   the analyst server is active. If your version has no per-server toggle, keep only the analyst
   entry in the config for scenes 1–3, then swap it for the admin entry and restart (cut the restart
   out of the recording).

5. Open a terminal in the project folder, ready for the last scene.

6. Do one dry run. Claude's wording changes between runs; the numbers and the masking do not.

## The script

| Time      | Do this                                                                                                                                           | What it shows                                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:10 | Say: "Claude Desktop, connected to an MCP server over a synthetic loan portfolio. Claude can only use five read-only tools. It never writes SQL." | Sets the scene.                                                                                                                                                                                                                                   |
| 0:10–0:25 | Ask: **"Summarise the portfolio and tell me which region has the highest delinquency."**                                                          | Claude calls `get_portfolio_summary`. Expect 574 active loans, about $65.7M outstanding, 5.75% delinquency, Southeast highest at 9.35%. Point out the tool-call panel: the answer comes from the server, not from the model.                      |
| 0:25–0:40 | Ask: **"List the five largest defaulted loans with the customer names."**                                                                         | **Masking as analyst.** Names come back as `A*** B***`. The top loan is LN-000189, a West mortgage of about $473,000. Say: "The analyst role never receives real names. Masking happens in the data layer, so no prompt can switch it off."       |
| 0:40–0:55 | Switch to `loans-admin` (toggle analyst off, admin on). Start a new chat and ask the same question.                                               | **Full names as admin.** Same five loans, now with real (synthetic) names. Say: "Same question, different identity. The role comes from who is calling, not from what they ask."                                                                  |
| 0:55–1:10 | Ask: **"Call search_loans with pageSize 200. Use exactly that value, don't adjust it."**                                                          | **Rejected invalid input.** The tool returns `INVALID_INPUT` with `pageSize: Too big: expected number to be <=50`. Claude explains the 50-row limit and usually offers to page through instead. No data was returned and no stack trace is shown. |
| 1:10–1:30 | In the terminal, run: **`npm run audit:tail`**                                                                                                    | **The audit log.** One row per call: time, user (`analyst-demo`, `admin-demo`), role, tool, outcome, row count and duration. Point at the `invalid_input` row. Say: "Every call is recorded, including the rejected one. The log is append-only." |

Close on the audit table, or on the README's architecture diagram.

## If something goes off-script

- **Claude caps pageSize at 50 by itself instead of sending 200.** Claude reads the tool's schema
  and sometimes corrects the request before calling. Use the backup:
  **"Get the details for loan ABC-123."** The server rejects it with `INVALID_INPUT`:
  `Loan reference must look like LN-000123`.
- **Claude answers from both servers at once.** Only one of `loans-analyst` / `loans-admin` should
  be active at a time. Turn the other off, or start a new chat.
- **`npm run audit:tail` says the database uses the v1.0 layout.** An old audit file from before
  resource and prompt auditing. Make any tool call (the server upgrades the file on startup), or
  delete `data/audit.db` and record again.
- **Different numbers from the ones above.** The database was seeded with `npm run seed` instead of
  `npm run seed:demo`. Re-run `npm run seed:demo` and restart Claude Desktop.

## Optional extras (if you have more time)

- **"What exactly does delinquency rate mean here?"** Shows `explain_metric`: the definition comes
  from the server.
- **"How has delinquency changed over the last 12 months?"** Shows `get_delinquency_trend`: flat
  around 2–3% until July 2026, then rising every month to 5.75% in October 2026.
- Run the **monthly_portfolio_review** prompt, then `npm run audit:tail` again. The prompt read
  appears with kind `prompt`.
