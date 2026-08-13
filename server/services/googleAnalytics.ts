import { BetaAnalyticsDataClient } from '@google-analytics/data';

let analyticsClient: BetaAnalyticsDataClient | null = null;
let isConfigured = false;
let configError: string | null = null;

try {
  const serviceAccountJson = process.env.GA_SERVICE_ACCOUNT_JSON;
  const propertyId = process.env.GA4_PROPERTY_ID;

  if (!propertyId) {
    configError = "GA4_PROPERTY_ID não está configurado nas variáveis de ambiente do Render.";
  } else if (!serviceAccountJson) {
    configError = "GA_SERVICE_ACCOUNT_JSON não está configurado nas variáveis de ambiente do Render.";
  } else {
    let credentials: any;
    try {
      credentials = JSON.parse(serviceAccountJson);
    } catch (parseErr: any) {
      configError = "GA_SERVICE_ACCOUNT_JSON possui formato JSON inválido: " + parseErr.message;
    }

    if (credentials && credentials.client_email && credentials.private_key) {
      analyticsClient = new BetaAnalyticsDataClient({
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key.replace(/\\n/g, '\n'),
        },
      });
      isConfigured = true;
      configError = null;
    } else {
      configError = "GA_SERVICE_ACCOUNT_JSON não contém client_email ou private_key válidos.";
    }
  }
} catch (err: any) {
  configError = "Erro ao inicializar Google Analytics Data Client: " + err.message;
  isConfigured = false;
  analyticsClient = null;
}

export function getGA4Status() {
  return {
    isConfigured,
    propertyId: process.env.GA4_PROPERTY_ID || null,
    error: configError
  };
}

export async function fetchGA4Report(startDate = '7daysAgo', endDate = 'today'): Promise<any> {
  if (!isConfigured || !analyticsClient) {
    throw new Error(configError || "Google Analytics Data API não está configurada.");
  }

  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) {
    throw new Error("GA4_PROPERTY_ID não definido.");
  }

  try {
    const [response] = await analyticsClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }, { name: 'sessionSource' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'sessions' }],
    });

    let totalPageViews = 0;
    let totalActiveUsers = 0;
    let totalSessions = 0;
    const topPages: Record<string, number> = {};
    const sources: Record<string, number> = {};

    if (response.rows) {
      for (const row of response.rows) {
        const path = row.dimensionValues?.[0]?.value || '/';
        const source = row.dimensionValues?.[1]?.value || '(direct)';
        const views = parseInt(row.metricValues?.[0]?.value || '0', 10);
        const users = parseInt(row.metricValues?.[1]?.value || '0', 10);
        const sessions = parseInt(row.metricValues?.[2]?.value || '0', 10);

        totalPageViews += views;
        totalActiveUsers += users;
        totalSessions += sessions;

        topPages[path] = (topPages[path] || 0) + views;
        sources[source] = (sources[source] || 0) + sessions;
      }
    }

    return {
      success: true,
      totalPageViews,
      totalActiveUsers,
      totalSessions,
      topPages,
      sources,
      rawRowsCount: response.rows?.length || 0
    };
  } catch (err: any) {
    throw new Error("Falha ao consultar Google Analytics Data API: " + err.message);
  }
}
