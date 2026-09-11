-- ============================================================
-- GESTÃO DE SACAS — schema do Supabase
-- Rode este arquivo inteiro em Supabase > SQL Editor > New query
-- (num projeto novo, do zero — os "create table if not exists" não
-- fazem nada se a tabela já existir).
--
-- Se você já tinha rodado uma versão anterior deste schema, rode só
-- estes dois comandos em vez do arquivo inteiro:
--
--   alter table fila alter column saca drop not null;
--   drop table if exists roster;  -- não é mais usada (a Lista agora
--                                  -- insere direto na fila)
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- usuários do sistema (liga o login do Supabase Auth ao perfil) ----------
create table if not exists usuarios_sacas (
  id         uuid primary key references auth.users(id) on delete cascade,
  nome       text not null,
  perfil     text not null default 'operador' check (perfil in ('operador', 'gestor')),
  criado_em  timestamptz not null default now()
);

-- ---------- histórico de motoristas (alimenta o autocompletar da Fila) ----------
create table if not exists motoristas (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null unique,
  vezes       integer not null default 0,
  ultima_vez  date,
  criado_em   timestamptz not null default now()
);

-- ---------- fila: motorista aguardando saca ou liberação ----------
-- saca fica nula quando o nome veio colado na aba Lista e o motorista
-- ainda não chegou pra informar o número; é preenchida na Fila.
create table if not exists fila (
  id         uuid primary key default gen_random_uuid(),
  motorista  text not null,
  saca       integer check (saca between 1 and 999),
  dia        date not null,
  criado_em  timestamptz not null default now()
);

-- ---------- registros: sacas já liberadas ou recusadas ----------
create table if not exists registros (
  id            uuid primary key default gen_random_uuid(),
  motorista     text not null,
  saca          integer not null check (saca between 1 and 999),
  status        text not null check (status in ('levou', 'recusou')),
  faltantes     jsonb not null default '[]'::jsonb,
  dia           date not null,
  ts_fila       timestamptz,
  ts_resolvido  timestamptz not null default now(),
  criado_em     timestamptz not null default now()
);

create index if not exists registros_dia_idx on registros (dia);
create index if not exists registros_status_idx on registros (status);
create index if not exists fila_dia_idx on fila (dia);

-- ============================================================
-- RLS — bloqueia acesso anônimo, mas não trava a equipe entre si.
-- Diferente do padrão "RLS desligado" usado nos módulos do GBS/MNS:
-- aqui existe login de verdade (Supabase Auth), então cada tabela
-- fica com UMA política simples: "usuário autenticado pode tudo".
-- Isso fecha a porta pra quem não tem login, sem criar regra por
-- linha que possa travar alguém silenciosamente.
-- ============================================================
alter table usuarios_sacas enable row level security;
alter table motoristas     enable row level security;
alter table fila           enable row level security;
alter table registros      enable row level security;

create policy "cada um vê o próprio perfil" on usuarios_sacas
  for select using (auth.uid() = id);

create policy "equipe autenticada - acesso total" on motoristas
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "equipe autenticada - acesso total" on fila
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "equipe autenticada - acesso total" on registros
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ============================================================
-- Depois de rodar isso, crie os usuários em
-- Authentication > Users > Add user (no painel do Supabase) e então
-- rode um insert por pessoa, trocando o UUID pelo "User UID" que
-- aparece na lista de usuários:
--
-- insert into usuarios_sacas (id, nome, perfil) values
--   ('cole-o-uuid-aqui', 'Nome do atendente', 'operador');
--
-- insert into usuarios_sacas (id, nome, perfil) values
--   ('cole-o-uuid-aqui', 'Nome do gestor', 'gestor');
-- ============================================================
