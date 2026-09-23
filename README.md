# Agenda Studio

Sistema de agendamentos para manicures, salões e profissionais de beleza.

- **Página pública** (`/`): o link enviado às clientes. Elas escolhem serviços, dia e horário livre e confirmam.
- **Painel da dona** (`/admin`): protegido por login. Agenda, serviços, clientes, finanças e ajustes.

Os dados ficam no **Supabase** (banco de dados na nuvem). As regras de segurança do banco garantem que
as clientes só consigam ver serviços e horários livres e criar agendamentos. Todo o resto é visível
apenas para a dona.

## Estrutura

```
index.html            página pública de agendamento
admin/index.html      painel da dona (login)
admin/sw.js           permite instalar o painel como app no celular
css/styles.css        estilos (tema claro/escuro automático)
js/config.js          URL e chave pública do Supabase  ← preencher
js/core.js            funções compartilhadas
js/api.js             comunicação com o Supabase
js/admin.js           lógica do painel
js/public.js          lógica da página pública
supabase/schema.sql   tabelas, regras de segurança e funções do banco
```

## Passo a passo — Supabase

1. Crie uma conta em https://supabase.com e clique em **New project**.
   Escolha um nome, crie uma senha forte para o banco e a região **South America (São Paulo)**.
2. No menu lateral, abra **SQL Editor → New query**, cole todo o conteúdo de `supabase/schema.sql` e clique em **Run**.
3. Em **Authentication → Users → Add user → Create new user**, cadastre o e-mail e a senha da dona
   (marque **Auto Confirm User**).
4. Volte ao **SQL Editor** e rode (trocando o e-mail):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'email-da-dona@exemplo.com';
   ```
5. Em **Authentication → Sign In / Providers**, **desative** "Allow new users to sign up".
   Assim ninguém consegue criar conta sozinho.
6. Em **Project Settings → API Keys** (e **Data API** para a URL), copie a **Project URL** e a chave
   **publishable** (ou **anon**) e cole em `js/config.js`.
   Nunca use a chave **secret / service_role** no site.

## Testar no computador

Dê dois cliques em `iniciar.bat` (requer Python) e acesse:
- http://localhost:5500 — página das clientes
- http://localhost:5500/admin — painel da dona

## Publicação (GitHub Pages)

O site é publicado automaticamente pelo GitHub Pages a cada `git push` na branch `main`.

- Link das clientes: https://leonhauck.github.io/agenda-studio/
- Painel da dona: https://leonhauck.github.io/agenda-studio/admin/

Para publicar uma alteração:

```bash
git add .
git commit -m "Descreva a alteração"
git push
```

A atualização aparece no site em 1 a 2 minutos.
