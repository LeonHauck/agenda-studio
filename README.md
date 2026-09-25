<div align="center">

<img src="icons/icon-192.png" alt="Agenda Studio" width="96" height="96">

# Agenda Studio

**Agendamento online para salões, manicures e profissionais de beleza**

As clientes marcam horário sozinhas por um link, e a dona gerencia agenda, clientes e finanças num painel próprio.

[![Site](https://img.shields.io/badge/🌐_Agendar-leonhauck.github.io-b4537a?style=for-the-badge)](https://leonhauck.github.io/agenda-studio/)
[![Painel](https://img.shields.io/badge/🔒_Painel-admin-1c1a19?style=for-the-badge)](https://leonhauck.github.io/agenda-studio/admin/)

![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat-square&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?style=flat-square&logo=supabase&logoColor=white)
![GitHub Pages](https://img.shields.io/badge/GitHub_Pages-222222?style=flat-square&logo=githubpages&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-instalável-5A0FC8?style=flat-square&logo=pwa&logoColor=white)

</div>

---

## ✨ Funcionalidades

### 💅 Para as clientes (link público)
- 🛍️ Escolha de um ou mais serviços, com **valor e duração somados** automaticamente
- 📅 Somente **horários realmente livres**, que comportam a duração escolhida
- ✅ Agendamento **confirmado na hora**, sem precisar criar conta
- 📲 Atalhos para salvar na agenda do celular e falar com o estúdio pelo WhatsApp
- 🔁 **Link pessoal** para ver, remarcar ou cancelar o próprio horário (dentro do prazo definido pela dona)

### 🔒 Para a dona (painel com login)
| | Aba | O que faz |
|---|---|---|
| 📆 | **Agenda** | Visão semanal, horários livres, encaixes, status e remarcação com aviso por WhatsApp |
| 🔒 | **Bloqueios** | Dia inteiro, vários dias (férias) ou período do dia; o motivo fica visível só para a dona |
| 💅 | **Serviços** | Nome, valor, duração e cor; escolha do que aparece no link público |
| 👥 | **Clientes** | Cadastro automático, busca, histórico, total pago e atalho para WhatsApp |
| 📊 | **Finanças** | Filtro por dia, semana ou mês; faturado × a receber; gráfico; por serviço e forma de pagamento |
| ⚙️ | **Ajustes** | Horário e dias de atendimento, intervalo entre horários, cor do app, link e backup |

- 🔔 Atualização em **tempo real** quando uma cliente agenda, remarca ou cancela
- ⏰ **Lembretes** do próximo dia com mensagem pronta no WhatsApp, incluindo o link de remarcação
- 📱 **Instalável** no celular como aplicativo (Android e iPhone)
- 🌗 Tema claro e escuro automáticos

---

## 🛡️ Segurança

As regras ficam **no banco de dados** (Row Level Security do Supabase), não no site:

| Quem | Pode |
|---|---|
| 🌐 Visitante | Ver serviços ativos e horários ocupados (**sem nomes**) e criar agendamentos pela função `book_appointment` |
| 🔗 Cliente com link pessoal | Ver, remarcar ou cancelar **somente o próprio horário** (`get_booking`, `reschedule_booking`, `cancel_booking`) |
| 🔒 Dona (tabela `admins`) | Ler e editar tudo |

A função de agendamento valida no servidor os serviços, o expediente, horários no passado, conflitos e o limite de 3 horários futuros por telefone.

---

## 🗂️ Estrutura

```
📁 agenda-studio
├── 📄 index.html             página pública de agendamento
├── 📁 admin
│   ├── 📄 index.html         painel da dona (login)
│   ├── 📄 manifest.webmanifest
│   └── 📄 sw.js              instalação como app (PWA)
├── 📁 css
│   └── 🎨 styles.css         estilos (tema claro/escuro)
├── 📁 js
│   ├── ⚙️ config.js          URL e chave pública do Supabase
│   ├── 🧩 core.js            funções compartilhadas
│   ├── 🔌 api.js             comunicação com o Supabase
│   ├── 🔒 admin.js           lógica do painel
│   └── 🌐 public.js          lógica da página pública
├── 📁 icons                  ícones do app (SVG e PNG)
└── 📁 supabase
    └── 🗄️ schema.sql         tabelas, regras de segurança e funções
```

---

## 🚀 Instalação

### 1️⃣ Supabase
1. Crie um projeto em [supabase.com](https://supabase.com), na região **South America (São Paulo)**.
2. Em **SQL Editor**, rode todo o conteúdo de [`supabase/schema.sql`](supabase/schema.sql).
3. Em **Authentication → Users**, crie o usuário da dona (**Auto Confirm User**).
4. Dê acesso de administradora:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'email-da-dona@exemplo.com';
   ```
5. Em **Authentication → Sign In / Providers**, desative **Allow new users to sign up**.
6. Copie a **Project URL** e a chave **publishable** para [`js/config.js`](js/config.js).
7. **Recuperação de senha:** configure um SMTP próprio em **Authentication → Emails → SMTP Settings**, a URL do painel em **Authentication → URL Configuration** e cole o modelo [`supabase/email-recuperar-senha.html`](supabase/email-recuperar-senha.html) em **Emails → Templates → Reset Password**.

> [!WARNING]
> Nunca coloque a chave **secret / service_role** no site. A chave publishable foi feita para ficar pública.

### 2️⃣ Testar localmente
Dê dois cliques em `iniciar.bat` (requer Python) e acesse:
- 🌐 http://localhost:5500: página das clientes
- 🔒 http://localhost:5500/admin: painel da dona

### 3️⃣ Publicar (GitHub Pages)
O site é publicado automaticamente a cada `git push` na branch `main`:

```bash
git add .
git commit -m "Descreva a alteração"
git push
```

> [!TIP]
> A atualização aparece no site em 1 a 2 minutos. Se não aparecer, use **Ctrl+F5**.

---

## 🛣️ Próximas ideias
- [x] 🚫 Bloqueio de datas e horários (folgas, feriados, férias)
- [ ] 🍽️ Bloqueios recorrentes (ex.: almoço todos os dias)
- [x] ⏰ Lembretes com mensagem pronta no WhatsApp
- [x] 🔁 Link para a cliente remarcar ou cancelar sozinha
- [x] 🔑 Recuperação de senha por e-mail

---

<div align="center">

Desenvolvido por **[Leon Hauck](https://www.linkedin.com/in/leon-hauck/)**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-leon--hauck-0A66C2?style=flat-square&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/leon-hauck/)
[![GitHub](https://img.shields.io/badge/GitHub-LeonHauck-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/LeonHauck)

</div>
