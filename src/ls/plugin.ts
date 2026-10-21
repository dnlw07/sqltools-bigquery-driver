import { ILanguageServerPlugin } from '@sqltools/types';
import YourDriver from './driver';
import { DRIVER_ALIASES } from './../constants';

const YourDriverPlugin: ILanguageServerPlugin = {
  register(server) {
    DRIVER_ALIASES.forEach(({ value }) => {
      server.getContext().drivers.set(value, YourDriver as any);
    });
    server.onRequest('bigquery/ConfigureCompletionStorage', async (params: { path: string }) => {
      YourDriver.completionStoragePath = params.path;
    });
    server.onRequest('bigquery/EstimateQuery', async (params: { connectionId: string; name?: string; connectionName?: string; query: string }) => {
      return YourDriver.estimateFor(params.connectionId, params.query, params.name);
    });
    server.onRequest('bigquery/RefreshCompletionCatalog', async () => {
      await YourDriver.refreshCompletionCatalogs();
    });
  }
}

export default YourDriverPlugin;
