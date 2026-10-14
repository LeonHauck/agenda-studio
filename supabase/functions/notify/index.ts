// Edge Function "notify": envia uma notificação push para os aparelhos da dona.
//
// É chamada pelo próprio banco (gatilho em public.activity) a cada novidade:
// agendamento online, remarcação, cancelamento pela cliente ou sinal vencido.
//
// Segredos necessários (Supabase → Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT  → identificam o sistema para o serviço de push
//   PUSH_SECRET                                         → o mesmo valor de public.secrets.push_secret
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem por padrão em toda Edge Function.
//
// Publicada com a verificação de JWT desligada: a proteção é o cabeçalho x-push-secret.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

// Chave de servidor do projeto (formato antigo "service_role" ou novo "secret"), já disponível na função
function serverKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    const first = Object.values(keys)[0];
    if (typeof first === 'string') return first;
  } catch { /* segue para o erro abaixo */ }
  throw new Error('Chave de servidor não encontrada nas variáveis da Edge Function');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Método não permitido', { status: 405 });
  if (req.headers.get('x-push-secret') !== Deno.env.get('PUSH_SECRET')) {
    return new Response('Proibido', { status: 403 });
  }

  const { title, body, tag } = await req.json();
  webpush.setVapidDetails(
    Deno.env.get('VAPID_SUBJECT')!,
    Deno.env.get('VAPID_PUBLIC_KEY')!,
    Deno.env.get('VAPID_PRIVATE_KEY')!,
  );

  const db = createClient(Deno.env.get('SUPABASE_URL')!, serverKey());
  const { data: subs, error } = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth');
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const payload = JSON.stringify({ title, body, tag });
  let sent = 0;
  const failures: string[] = [];
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 });
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // Aparelho que desinstalou o app ou desativou as notificações: remove o registro
      if (status === 404 || status === 410) await db.from('push_subscriptions').delete().eq('id', s.id);
      else failures.push(`${status ?? ''} ${(err as Error).message}`);
    }
  }
  return Response.json({ sent, total: subs?.length ?? 0, failures });
});
