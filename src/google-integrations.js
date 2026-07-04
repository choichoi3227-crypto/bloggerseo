import { kvSetJson } from './store.js';
export function googleIntegrationStatus(env) {
  return {
    mode: 'service_account',
    loginPackage: 'google-auth-library compatible JWT flow',
    clientInputRequired: false,
    searchConsole: !!env.GOOGLE_SERVICE_ACCOUNT_JSON,
    adsense: !!env.GOOGLE_SERVICE_ACCOUNT_JSON,
    trends: true,
    note: '서비스 계정 JSON은 GOOGLE_SERVICE_ACCOUNT_JSON secret으로만 입력합니다.',
  };
}
export async function runGoogleSync(env) {
  const status = googleIntegrationStatus(env);
  await kvSetJson(env, 'state:google:status', { ...status, syncedAt: Date.now() }, 3600);
  return { ok: true, ...status };
}
