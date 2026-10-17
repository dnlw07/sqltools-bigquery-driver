import * as vscode from 'vscode';
import { IExtension, IExtensionPlugin, IDriverExtensionApi } from '@sqltools/types';
import { ExtensionContext } from 'vscode';
import { DRIVER_ALIASES } from './constants';
const { publisher, name, displayName } = require('../package.json');

// Selected text, or the ';'-delimited statement around the cursor.
function getStatementAtCursor(editor: vscode.TextEditor): string | undefined {
  const { document, selection } = editor;
  if (!selection.isEmpty) return document.getText(selection).trim() || undefined;
  const text = document.getText();
  const offset = document.offsetAt(selection.active);
  const start = text.lastIndexOf(';', Math.max(offset - 1, 0)) + 1;
  const endIndex = text.indexOf(';', offset);
  const statement = text.slice(offset > 0 && text[offset - 1] === ';' ? offset : start, endIndex === -1 ? text.length : endIndex);
  const withoutComments = statement.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '').trim();
  return /^(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE)\b/i.test(withoutComments) ? statement.trim() : undefined;
}

export async function activate(extContext: ExtensionContext): Promise<IDriverExtensionApi> {
  const sqltools = vscode.extensions.getExtension<IExtension>('mtxr.sqltools');
  if (!sqltools) {
    throw new Error('SQLTools not installed');
  }
  await sqltools.activate();

  const api = sqltools.exports;

  const extensionId = `${publisher}.${name}`;
  const plugin: IExtensionPlugin = {
    extensionId,
    name: `${displayName} Plugin`,
    type: 'driver',
    async register(extension) {
      // register ext part here
      extension.resourcesMap().set(`driver/${DRIVER_ALIASES[0].value}/icons`, {
        active: extContext.asAbsolutePath('icons/active.png'),
        default: extContext.asAbsolutePath('icons/default.png'),
        inactive: extContext.asAbsolutePath('icons/inactive.png'),
      });
      DRIVER_ALIASES.forEach(({ value }) => {
        extension.resourcesMap().set(`driver/${value}/extension-id`, extensionId);
        extension
          .resourcesMap()
          .set(`driver/${value}/connection-schema`, extContext.asAbsolutePath('connection.schema.json'));
        extension.resourcesMap().set(`driver/${value}/ui-schema`, extContext.asAbsolutePath('ui.schema.json'));
      });
      await extension.client.sendRequest('ls/RegisterPlugin', { path: extContext.asAbsolutePath('out/ls/plugin.js') });
      await extension.client.sendRequest('bigquery/ConfigureCompletionStorage', {
        path: vscode.Uri.joinPath(extContext.globalStorageUri, 'completion-catalogs').fsPath,
      });
      extContext.subscriptions.push(vscode.commands.registerCommand('sqltools.bigquery.refreshAutocomplete', async () => {
        try {
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification, title: 'Refreshing BigQuery autocomplete',
          }, () => extension.client.sendRequest('bigquery/RefreshCompletionCatalog'));
          vscode.window.showInformationMessage('BigQuery autocomplete catalogs refreshed.');
        } catch (error) {
          vscode.window.showErrorMessage(`BigQuery autocomplete refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }));
      const estimateKey = 'bigquery.estimateQuery';
      let estimateTimer: NodeJS.Timeout | undefined;
      let lastEstimated = '';
      const estimateStatementAtCursor = async (editor: vscode.TextEditor) => {
        const query = getStatementAtCursor(editor);
        if (!query) return;
        const connections: any[] = await vscode.commands.executeCommand('sqltools.getConnections', { connectedOnly: true }) || [];
        const aliases = DRIVER_ALIASES.map(({ value }) => value);
        const bigQueryConnections = connections.filter(c => aliases.includes(c.driver));
        const conn = bigQueryConnections.find(c => c.isActive) || bigQueryConnections[0];
        if (!conn) return;
        // The toggle command overrides the per-connection "Estimate Query" setting.
        if (!(extContext.globalState.get<boolean>(estimateKey) ?? conn.estimateQuery === true)) return;
        const connectionId = conn.id || `${conn.name}|${conn.driver}`;
        const key = `${connectionId}\n${query}`;
        if (key === lastEstimated) return;
        lastEstimated = key;
        const message: string | undefined = await extension.client.sendRequest('bigquery/EstimateQuery', { connectionId, query });
        if (message) {
          vscode.window.showInformationMessage(message);
          await vscode.commands.executeCommand('sqltools.addConsoleMessage', message);
        }
      };
      extContext.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
        if (!['sql', 'bqsql'].includes(event.textEditor.document.languageId)) return;
        if (estimateTimer) clearTimeout(estimateTimer);
        estimateTimer = setTimeout(() => {
          estimateStatementAtCursor(event.textEditor).catch(error => {
            lastEstimated = '';
            vscode.commands.executeCommand('sqltools.addConsoleMessage', `Estimate unavailable: ${error instanceof Error ? error.message : String(error)}`);
          });
        }, 700);
      }));
      extContext.subscriptions.push({ dispose: () => estimateTimer && clearTimeout(estimateTimer) });
      extContext.subscriptions.push(vscode.commands.registerCommand('sqltools.bigquery.estimateQuery', async () => {
        const enabled = !(extContext.globalState.get<boolean>(estimateKey) ?? false);
        await extContext.globalState.update(estimateKey, enabled);
        lastEstimated = '';
        vscode.window.showInformationMessage(`BigQuery query estimate notifications ${enabled ? 'enabled' : 'disabled'}.`);
      }));
    },
  };
  api.registerPlugin(plugin);
  return {
    driverName: displayName,
    parseBeforeSaveConnection: ({ connInfo }) => {
      /**
       * This hook is called before saving the connection using the assistant
       * so you can do any transformations before saving it to disk.active
       * EG: relative file path transformation, string manipulation etc
       * Below is the exmaple for SQLite, where we save the DB path relative to workspace
       * and later we transform it back to absolute before editing
       */
      // if (path.isAbsolute(connInfo.database)) {
      //   const databaseUri = Uri.file(connInfo.database);
      //   const dbWorkspace = workspace.getWorkspaceFolder(databaseUri);
      //   if (dbWorkspace) {
      //     connInfo.database = `\$\{workspaceFolder:${dbWorkspace.name}\}/${workspace.asRelativePath(connInfo.database, false)}`;
      //   }
      // }
      return connInfo;
    },
    parseBeforeEditConnection: ({ connInfo }) => {
      /**
       * This hook is called before editing the connection using the assistant
       * so you can do any transformations before editing it.
       * EG: absolute file path transformation, string manipulation etc
       * Below is the exmaple for SQLite, where we use relative path to save,
       * but we transform to asolute before editing
       */
      // if (!path.isAbsolute(connInfo.database) && /\$\{workspaceFolder:(.+)}/g.test(connInfo.database)) {
      //   const workspaceName = connInfo.database.match(/\$\{workspaceFolder:(.+)}/)[1];
      //   const dbWorkspace = workspace.workspaceFolders.find(w => w.name === workspaceName);
      //   if (dbWorkspace)
      //     connInfo.database = path.resolve(dbWorkspace.uri.fsPath, connInfo.database.replace(/\$\{workspaceFolder:(.+)}/g, './'));
      // }
      return connInfo;
    },
    driverAliases: DRIVER_ALIASES,
  };
}

export function deactivate() {}
