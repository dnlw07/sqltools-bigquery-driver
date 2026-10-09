[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) 
![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/Evidence.sqltools-bigquery-driver)
![Visual Studio Marketplace Last Updated](https://img.shields.io/visual-studio-marketplace/last-updated/Evidence.sqltools-bigquery-driver)



# <img src="https://github.com/evidence-dev/sqltools-bigquery-driver/blob/master/icons/default.png?raw=true"  style="height:1em;"/> SQLTools for BigQuery

## Query and explore BigQuery from VSCode

A VSCode extension that extends [SQLTools](https://marketplace.visualstudio.com/items?itemName=mtxr.sqltools), with a driver for Google BigQuery. 

This driver is maintained by [Evidence](https://evidence.dev): an open-source BI tool to generate reports with SQL and Markdown.

![Connect DB](https://github.com/evidence-dev/sqltools-bigquery-driver/blob/master/docs/images/connect-db.gif?raw=true)

## Features

- Run queries on BiqQuery
- Explore datasets, tables and columns in the sidebar
- View table results by selecting them in the sidebar
- View stored procedures and functions in the sidebar
- Completion of common keywords (e.g. SELECT, FROM, WHERE)
- Dataset and table-name completion with object details (Table/View, Dataset, and Project). Qualified references such as `project.dataset.` show tables with a documentation panel; materialized views, external tables, snapshots, and clones are identified when available in API metadata.
- Unqualified `FROM`/`JOIN` prefixes suggest datasets (BigQuery schemas) before tables, including inside backticks. All dataset and table metadata pages are loaded before filtering, so typing can find matches beyond the initial displayed completion limit. After selecting `dataset.`, completion lists tables from that dataset without repeating datasets. Explorer project expansion uses the project ID, not the connection's display name.
- Dataset and table suggestions support case-insensitive, in-order abbreviated names: `custhist` matches `customer_order_history`. Characters may be skipped, but not reordered. Accepting the suggestion inserts the full name.


### Running a query

![Run Query](https://github.com/evidence-dev/sqltools-bigquery-driver/blob/master/docs/images/run-query.gif?raw=true)

### Exploring datasets, tables and columns

![Explore DB](https://github.com/evidence-dev/sqltools-bigquery-driver/blob/master/docs/images/db-explorer.gif?raw=true)

### Not Implemented

- Full BigQuery SQL-aware column completion

## Connection Methods

Supports the following connection methods:
- Service Account
- GCloud CLI
- OAuth Access Token

For more details on the above connection methods see [connection guides](https://docs.evidence.dev/core-concepts/data-sources/#bigquery).

## ToDo
- Add BigQuery-specific keywords
- Improve SQL-aware column completion

## Contributing
Contributions are welcome. If you need help getting started, feel free to reach out on [Slack](https://slack.evidence.dev) in the #sqltools channel

### Maintained by [<img src="https://github.com/evidence-dev/sqltools-bigquery-driver/blob/master/docs/images/evidence.png?raw=true"  style="height:1em;"/>](https://www.evidence.dev)
