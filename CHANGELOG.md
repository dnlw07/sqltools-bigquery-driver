# Changelog

## 0.0.27 - 2026-10-17

- Fix caret estimate never appearing: the language server looked the connection up only after autocomplete had loaded a catalog; it now tracks every open connection. Errors are reported in the SQLTools Console, and `bqsql` files are supported.

## 0.0.26 - 2026-10-17

- The query estimate is shown as a notification (and in the SQLTools Console) when a statement is selected or the caret is on it, before execution. Estimation is no longer repeated when the query runs.

## 0.0.25 - 2026-10-17

- Pre-execution estimate at the caret now also honours the connection's Estimate Query setting, not only the toggle command.

## 0.0.24 - 2026-10-17

- Fix query estimation: dry-run statistics are now read from the job itself (fetching them from the API failed, so no estimate appeared). Failures are reported in the SQLTools Console.
- With estimation enabled, placing the caret on (or selecting) a statement adds its estimate to the SQLTools Console. Requires SQLTools 0.28.50+.

## 0.0.23 - 2026-10-17

- Show the query estimate as a VS Code notification (previously only added to the result Messages tab).

## 0.0.22 - 2026-10-17

- The "Estimate query" command now toggles estimate notifications on/off (remembered across sessions, overrides the per-connection setting) instead of opening settings.

## 0.0.21 - 2026-10-17

- Ignore SQL comments when locating the source table, so a commented-out FROM clause above the query no longer breaks column mapping and Copy as INSERT/UPDATE.

## 0.0.20 - 2026-10-17

- Try every candidate project (referenced tables, configured project, client project) when mapping result columns, so views and tables in other projects are editable; the unmapped message now names the resolved table and columns.

## 0.0.19 - 2026-10-17

- Resolve the source project of unqualified `dataset.table` queries from the query's dry-run metadata instead of assuming the configured project, fixing the "Result columns cannot be mapped to the source BigQuery table" message and the missing Copy as INSERT/UPDATE actions.

## 0.0.18 - 2026-10-17

- Fix `Cannot find module '@sqltools/base-driver'` when loading the plugin in 0.0.16 and 0.0.17. `@sqltools/base-driver` is again a build-time (dev) dependency so it is bundled into `out/ls/plugin.js`.

## 0.0.17 - 2026-10-17

- Include `@sqltools/base-driver` as a production dependency so the packaged VSIX can load the BigQuery language-server plugin.

## 0.0.16 - 2026-10-17

- Add the `SQLTools UI - BigQuery driver: Estimate query` command to open SQLTools connection settings, where the per-connection estimate option can be enabled.

## 0.0.15 - 2026-10-17

- Fix `INFORMATION_SCHEMA` metadata references used for result editability. Unqualified `dataset.table` queries now resolve columns through the configured project and expose the grid copy/edit actions.

## 0.0.14 - 2026-10-17

- Fix result-column mapping and grid INSERT/UPDATE support for queries using an unqualified `dataset.table` reference by resolving the configured BigQuery project.
- Preserve explicitly qualified projects in result metadata, edits, and generated SQL.

## 0.0.13 - 2026-10-17
- Add the opt-in **SQLTools - BigQuery driver: Estimate Query** connection setting. When enabled, run a dry-run before each query and show estimated processed/billed bytes as an SQLTools notification; estimation failures log a warning and do not block execution.
- Preserve actual column names from query-result schema metadata for empty SELECT results, including paginated queries. Keep an empty row set instead of adding a synthetic "No rows returned" column; DML/DDL outcome grids remain unchanged.

## 0.0.12 - 2026-10-09
- Replace per-dataset cache eviction with a compact project catalog, eight-request background loading, per-connection persisted snapshots, 15-minute background refresh, and a **Refresh Autocomplete Catalog** command. Cap rendered completions at 500 while preserving incomplete/loading state and full-catalog prefix filtering.
- Match dataset and table completion names case-insensitively with gaps (for example, `custhist` matches `customer_order_history`), rather than requiring a continuous substring. Dataset-first ordering and selected-dataset scope are unchanged.
- Load all dataset and table metadata pages before filtering, and return dataset-first completions consistently for empty, typed, and backtick-prefixed `FROM`/`JOIN` references. Matches on later pages remain available as the prefix narrows.
- Fix project expansion using the selected project ID instead of the parent connection name. Resolve service-account project IDs through the client.
- Restore dataset suggestions for unqualified table-name prefixes and use dataset-scoped API lookups after selecting a dataset.
- Add a details panel to dataset and table completions showing object type, dataset, and project. Recognize views, materialized views, external tables, snapshots, and clones when supplied by BigQuery metadata.
- Include view flags and project metadata in fallback table lookups so SQLTools displays views correctly.

## 0.0.10
- Added `disablePagination` connection setting to turn off the new query-pagination behavior entirely and go back to fetching the full result set in one call
- Added `disablePaginationCount` connection setting to skip the exact `COUNT(1)` query and always show an estimated total instead
- Fixed a bug where moving from page 1 to page 2 of a paginated result opened a new results tab while the original tab was left stuck on a loading spinner (subsequent page changes were unaffected). Cause: a fresh random `resultId` was generated for every page; it's now generated once per query run and kept stable across all of its pages
- Console `SELECT`/`WITH` queries now support pagination (`LIMIT n+1 OFFSET m`), with an exact row total via a `COUNT(1)` wrapper subquery (falling back to a look-ahead estimate), cached per query/run to avoid re-counting on every page turn
- Added `previewLimit` connection setting used as the default page size
- Added `connectionInitSql` connection setting: SQL executed once in a BigQuery session (`createSession: true`) right after the connection opens; the resulting `session_id` is reused on subsequent queries; failure aborts the connection
- No-result DML/DDL statements (`INSERT`/`UPDATE`/`DELETE`/`MERGE`/`CREATE`/`DROP`/`ALTER`/...) now show a one-row `Statement`/`Result` grid instead of a blank "No rows returned" grid; empty `SELECT`s are unaffected
- Internal metadata/explorer/"Show Records" queries are now tagged and excluded from the new pagination logic so they aren't truncated to the page size

## 0.0.9 
- Adds support for ARRAY results
- Upgrades BigQuery (@google-cloud/bigquery) to 7.9.0

## 0.0.8
- Fix published artifact

## 0.0.7
- Sort datasets and schemas alpahbetically in the explorer

## 0.0.6
- Fix Readme images

## 0.0.5
- View stored procedures, UDFs and table functions in the explorer
- Fix describeTable command
- Add icons for data types in the explorer
- Smaller extension size (10MB -> 150KB)

## 0.0.4
- Adds support for data in non-US regions

## 0.0.3
- Fixes bug where queries returning zero rows throw an error

## 0.0.2
- Fixes bugs with sidebar explorer
- Implements ability to view table results from explorer
- Adds GCloud CLI and OAuth Access Token as options for authentication
- Cleans up Connection UI

## 0.0.1
- Initial release