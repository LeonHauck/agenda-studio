// Configuração do Supabase.
// Copie estes dois valores do painel do Supabase: Project Settings → API Keys (e Data API para a URL).
// A chave "publishable"/"anon" é pública por natureza: pode ficar no site.
// A segurança vem das regras do banco (arquivo supabase/schema.sql).
// NUNCA coloque aqui a chave "secret" / "service_role".
window.AGENDA_CONFIG = {
  supabaseUrl: 'https://aytjhrcbuzwsboesoufn.supabase.co',
  supabaseKey: 'sb_publishable_EN5UjdeHVRUECHGo_kyGpg_3rqvfUnv',
  // Chave pública das notificações no celular (a privada fica só nos segredos do Supabase)
  vapidPublicKey: 'BBcMh8k1045_eZy6QY3w9r5735RtswybaNjvCCg01-Ew3Os1AIQ-M_mgCynAtiWnKcmqaMeiw2pUSB_q7FBxjuQ',
};
