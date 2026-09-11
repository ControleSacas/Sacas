# Gestão de Sacas

Sistema para o ponto de retirada: motorista chega, é anotado na **Fila** (nome + número
da saca), sai pra escanear em outro app, volta e alguém confirma em **Liberar** se ele
levou ou recusou a saca. Pacote faltante é reportado depois, já na aba **Liberadas**,
quando o motorista termina de conferir. Sistema separado do restante do GBS/MNS — login
e banco próprios.

Stack: HTML/CSS/JS puro (sem build) + [Supabase](https://supabase.com) (banco + login) +
deploy estático na [Vercel](https://vercel.com).

## Arquivos

- `index.html` — a página única do app (login + as 6 abas).
- `app.js` — toda a lógica, incluindo as chamadas ao Supabase.
- `config.js` — **o único arquivo que você precisa editar** para ligar o app ao seu projeto Supabase.
- `sql/schema.sql` — cria as tabelas, os índices e as regras de acesso (RLS) no Supabase.

## 1. Criar o projeto no Supabase

1. Crie uma conta/projeto em [supabase.com](https://supabase.com) (plano free serve).
2. No painel do projeto, abra **SQL Editor > New query**, cole o conteúdo de
   `sql/schema.sql` e rode. Isso cria as tabelas `usuarios_sacas`, `motoristas`,
   `roster`, `fila` e `registros`, já com a segurança (RLS) configurada.
3. Em **Project Settings > API**, copie a **Project URL** e a **anon public key**.
4. Abra `config.js` e cole os dois valores:

   ```js
   window.GESTAO_SACAS_CONFIG = {
     supabaseUrl: "https://xxxxxxxx.supabase.co",
     supabaseAnonKey: "eyJhbGciOi..."
   };
   ```

   A anon key é pública por natureza (todo app Supabase client-side expõe ela) — quem
   protege os dados é a regra de RLS do schema, que só libera quem tem login. Não tem
   problema esse arquivo ir pro GitHub.

## 2. Criar os logins

O Supabase Auth cuida de senha/sessão; a tabela `usuarios_sacas` só diz **quem é
gestor**. Repita para cada pessoa:

1. **Authentication > Users > Add user** — coloque um e-mail (pode ser algo como
   `ponto1@suaempresa.com.br` mesmo que não receba e-mail de verdade) e uma senha.
   Marque **Auto Confirm User** pra não precisar de confirmação por e-mail.
2. Copie o **User UID** que aparece na lista.
3. No **SQL Editor**, rode um insert pra esse UID:

   ```sql
   insert into usuarios_sacas (id, nome, perfil) values
     ('cole-o-uuid-aqui', 'Nome da pessoa', 'operador');  -- ou 'gestor'
   ```

Quem é `'gestor'` também enxerga a aba **Relatórios**; `'operador'` só vê o
dia a dia (Fila, Liberar, Liberadas, Recusadas, Lista).

## 3. Testar localmente

Não precisa de servidor especial — qualquer servidor estático funciona, por exemplo:

```bash
npx serve .
```

Ou abra `index.html` direto no navegador (funciona também, já que não há build).

## 4. Subir pro GitHub

```bash
cd gestao-sacas
git init
git add .
git commit -m "Gestão de Sacas — versão inicial"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/gestao-sacas.git
git push -u origin main
```

## 5. Deploy na Vercel

1. [vercel.com](https://vercel.com) > **Add New > Project** > importe o repositório do GitHub.
2. Framework: **Other** (é site estático, sem build). Build Command e Output Directory
   podem ficar em branco/default — a Vercel serve os arquivos como estão.
3. Deploy. Pronto, a URL da Vercel já é o link pra abrir no celular do pessoal do ponto.

## Sobre o RLS (por que é diferente dos outros módulos do GBS)

Nos módulos antigos do GBS/MNS o padrão é desligar o RLS e controlar o acesso só pela
tela de login do app. Aqui o login é de verdade (Supabase Auth), então o `schema.sql`
deixa o RLS **ligado**, com uma política simples por tabela: "usuário autenticado pode
tudo". Isso fecha a porta pra quem não tem login (a anon key sozinha não abre nada),
sem criar regra por linha que possa travar alguém em silêncio.

## Limites conhecidos deste MVP

- **Relatórios** é só uma aba escondida da UI pra quem é `operador` — não é uma
  barreira de segurança separada (as mesmas linhas de `registros` que aparecem em
  Liberadas/Recusadas alimentam o relatório). Se isso precisar virar proteção de
  verdade um dia, dá pra mover a agregação pra uma function no Supabase.
- Sem tempo real (Realtime) — o app faz um polling leve (a cada 25s) nas abas Fila e
  Liberar pra pegar o que outro aparelho registrou. Se dois pontos usarem o sistema ao
  mesmo tempo, pode levar até 25s pra um ver o que o outro fez.
- Todas as consultas usam paginação (`fetchAll`) em vez de confiar no limite implícito
  do Supabase — o mesmo problema de corte silencioso em 1000 linhas que já pegou outros
  módulos do GBS/Exata foi evitado de propósito aqui.
