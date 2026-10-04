import { IBaseQueries, ContextValue} from '@sqltools/types';
import queryFactory from '@sqltools/base-driver/dist/lib/factory';

const quotePath = (...parts: string[]) => `\`${parts.map(part => String(part).replace(/`/g, '')).join('.') }\``;

const describeTable: IBaseQueries['describeTable'] = queryFactory`
  SELECT 
    column_name AS name,
    data_type AS dataType,
    is_nullable AS isNullable
  FROM ${p => quotePath(p.database, p.schema, 'INFORMATION_SCHEMA', 'COLUMNS')}
  WHERE table_name = '${p => p.label}'
  ORDER BY ordinal_position
`;

const fetchColumns: IBaseQueries['fetchColumns'] = queryFactory`
  SELECT 
    column_name AS label,
    column_name AS name,
    data_type AS dataType,
    is_nullable AS isNullable,
    table_name AS table,
    table_schema AS schema,
    case 
      WHEN data_type IN ('INT64') THEN 'symbol-number'
      WHEN data_type IN ( 'NUMERIC', 'BIGNUMERIC','FLOAT64') OR data_type LIKE 'DECIMAL(%' THEN 'symbol-number'
      WHEN data_type IN ('BIT', 'BITSTRING') THEN 'symbol-text'
      WHEN data_type IN ('BOOLEAN', 'BOOL', 'LOGICAL') THEN 'symbol-boolean'
      WHEN data_type IN ('BLOB', 'BYTEA', 'BINARY', 'VARBINARY') THEN 'symbol-binary'
      WHEN data_type IN ('DATE', 'TIME',  'TIMESTAMP', 'DATETIME', 'TIMESTAMP_NS', 'TIMESTAMP WITH TIME ZONE') THEN 'calendar'
      WHEN data_type = 'UUID' THEN 'symbol-u'
      WHEN data_type = 'JSON' THEN 'json'
      WHEN data_type = 'ARRAY' THEN 'array'
      WHEN data_type = 'GEOGRAPHY' THEN 'globe'
      WHEN data_type = 'STRUCT' OR data_type LIKE 'STRUCT%' THEN 'symbol-structure'
      WHEN data_type IN ('VARCHAR', 'CHAR', 'BPCHAR', 'TEXT', 'STRING') THEN 'symbol-text'
      ELSE 'symbol-constant'
    END as iconId,
    data_type AS detail,
    '${ContextValue.COLUMN}' as type
  FROM ${p => quotePath(p.database, p.schema, 'INFORMATION_SCHEMA', 'COLUMNS')}
  WHERE table_name = '${p => p.table}'
  ORDER BY ordinal_position
`;

// NB when you pass tables the parameters are different to when you pass schemas
const fetchRecords: IBaseQueries['fetchRecords'] = queryFactory`
  SELECT *
  FROM ${p => quotePath(p.table.database, p.table.schema, p.table.label)}
  LIMIT ${p => p.limit || 50}
  OFFSET ${p => p.offset || 0}
`;

// NB when you pass tables the parameters are different to when you pass schemas
const countRecords: IBaseQueries['countRecords'] = queryFactory`
  SELECT COUNT(1) AS total
  FROM ${p => quotePath(p.table.database, p.table.schema, p.table.label)}
`;

const fetchTablesAndViews = (
  type: ContextValue,
  tableType: string
): IBaseQueries['fetchTables'] => queryFactory`
  SELECT 
    table_name AS label,
    table_name AS table,
    table_schema AS schema,
    table_catalog AS database,
    '${type}' AS type
  FROM ${p => quotePath(p.database, p.schema, 'INFORMATION_SCHEMA', 'TABLES')}
    WHERE table_type IN ${tableType}
    ORDER BY table_name;
`;


const fetchRoutines: IBaseQueries['fetchFunctions'] = queryFactory`
  SELECT 
    routine_name AS label,
    routine_name AS table,
    routine_schema AS schema,
    routine_definition AS source,
    routine_definition AS snippet,
    routine_type AS detail,
    CASE 
      WHEN routine_type = 'PROCEDURE' THEN 'tasklist'
      ELSE null
    END AS iconId,
    '${ContextValue.FUNCTION}' AS type
  FROM ${p => quotePath(p.database, p.schema, 'INFORMATION_SCHEMA', 'ROUTINES')}
    ORDER BY routine_type, routine_name;
`;

const fetchRoutineInfo: IBaseQueries['fetchColumns'] = queryFactory`
SELECT 
  routine_definition AS label,
  '${ContextValue.COLUMN}' as type,
  'NO_CHILD' as childType,
  'triangle-right' as iconId
FROM ${p => quotePath(p.database, p.schema, 'INFORMATION_SCHEMA', 'ROUTINES')}
WHERE routine_name = '${p => p.label}'
`;

const fetchTables: IBaseQueries['fetchTables'] = fetchTablesAndViews(ContextValue.TABLE,`('BASE TABLE', 'EXTERNAL')`);
const fetchViews: IBaseQueries['fetchTables'] = fetchTablesAndViews(ContextValue.VIEW, `('VIEW')`);

const searchTables: IBaseQueries['searchTables'] = queryFactory`
  SELECT table_name AS label,
    table_schema AS schema,
    CASE WHEN table_type = 'VIEW' THEN '${ContextValue.VIEW}' ELSE '${ContextValue.TABLE}' END AS type,
    table_type AS detail
  FROM \`${(p: any) => String(p.database).replace(/`/g, '')}\`.INFORMATION_SCHEMA.TABLES
  WHERE 1 = 1
    ${p => p.search ? `AND LOWER(table_name) LIKE '%${p.search.toLowerCase()}%'` : ''}
  ORDER BY table_name
  LIMIT ${p => p.limit || 100}
`;

const searchSchemas: IBaseQueries['searchTables'] = queryFactory`
  SELECT schema_name AS label,
    schema_name AS schema,
    '${ContextValue.SCHEMA}' AS type,
    'dataset' AS detail
  FROM INFORMATION_SCHEMA.SCHEMATA
  WHERE 1 = 1
    ${p => p.search ? `AND LOWER(schema_name) LIKE '%${p.search.toLowerCase()}%'` : ''}
  ORDER BY schema_name
  LIMIT ${p => p.limit || 100}
`;

const searchColumns: IBaseQueries['searchColumns'] = queryFactory`
  SELECT c.column_name AS label,
    c.table_name AS "table",
    c.data_type AS dataType,
    c.is_nullable AS isNullable,
    c.is_primary_key AS isPk,
    '${ContextValue.COLUMN}' as type
  FROM ${p => p.schema}.${p => p.table}.INFORMATION_SCHEMA.COLUMNS AS c
  WHERE 1 = 1
    ${p => p.tables.filter(t => !!t.label).length ? `AND LOWER(c.table_name) IN (${p.tables.filter(t => !!t.label).map(t => `'${t.label}'`.toLowerCase()).join(', ')})` : ''}
    ${p => p.search ? `AND (
      LOWER(c.table_name || '.' || c.column_name) LIKE '%${p.search.toLowerCase()}%'
      OR LOWER(c.column_name) LIKE '%${p.search.toLowerCase()}%'
    )` : ''}
  ORDER BY c.table_name ASC,
    c.ordinal_position ASC
  LIMIT ${p => p.limit || 100}
`;

const fetchSchemas: IBaseQueries['fetchSchemas'] = queryFactory`
  SELECT
    schema_name as label,
    schema_name as schema,
    catalog_name as database,
    '${ContextValue.SCHEMA}' as type,
    'schema' as detail,
    'group-by-ref-type' as iconId
  FROM ${p => quotePath(p.database, 'INFORMATION_SCHEMA', 'SCHEMATA')}
  WHERE catalog_name = '${p => String(p.database).replace(/'/g, "''")}'
  ORDER BY schema_name
`;

const fetchDatabases: IBaseQueries['fetchDatabases'] = queryFactory`
  SELECT
    catalog_name as label,
    catalog_name as database,
    '${ContextValue.DATABASE}' as type,
    'database' as detail
  FROM INFORMATION_SCHEMA.SCHEMATA
  GROUP BY catalog_name
  ORDER BY catalog_name
`;

export default {
  describeTable,
  countRecords,
  fetchColumns,
  fetchRecords,
  fetchTables,
  fetchViews,
  fetchRoutines,
  fetchRoutineInfo,
  fetchSchemas,
  fetchDatabases,
  searchTables,
  searchSchemas,
  searchColumns,
  
}
