import dotenv from 'dotenv';
dotenv.config();
console.log({
  hasGitHubToken: !!process.env.GITHUB_TOKEN,
  hasDeployHook: !!process.env.RENDER_STATIC_DEPLOY_HOOK_URL,
  hasSupabaseUrl: !!process.env.SUPABASE_URL,
  deployHook: process.env.RENDER_STATIC_DEPLOY_HOOK_URL
});
