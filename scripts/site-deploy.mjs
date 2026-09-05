#!/usr/bin/env node
/**
 * site-deploy.mjs — деплой сайта-витрины на Vercel.
 *
 * Всегда ДВЕ команды: сначала сборка (`vercel deploy --prod`), потом перевод домена
 * на неё (`vercel alias set`). Без второго шага домен остаётся на предыдущей сборке —
 * страница отдаёт 200, но старую, и это выглядит как «деплой не сработал».
 *
 * Запуск (из корня студии):
 *   node scripts/site-deploy.mjs              # деплой + алиас + проверка 200
 *   node scripts/site-deploy.mjs --check      # только проверить, что домен живой
 *   node scripts/site-deploy.mjs --no-alias   # деплой без перевода домена (превью)
 *
 * Домен берётся из site/site.config.json (поле domain). Если он пуст — скрипт
 * подставит домен первого деплоя и запишет его туда сам.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const SITE = join(ROOT, 'site');
const CONFIG = join(SITE, 'site.config.json');

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const NO_ALIAS = argv.includes('--no-alias');

function die(msg) {
  console.error(`ОШИБКА: ${msg}`);
  process.exit(1);
}

if (!existsSync(SITE)) die(`не найдена папка сайта: ${SITE}`);
if (!existsSync(CONFIG)) die(`не найден ${CONFIG}`);

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));

function run(args, opts = {}) {
  console.log(`$ npx vercel ${args.join(' ')}`);
  const res = spawnSync('npx', ['--yes', 'vercel', ...args], {
    cwd: SITE,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (res.error) die(`не удалось запустить vercel: ${res.error.message}`);
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (out) console.log(out);
  if (res.status !== 0) {
    if (/not authenticated|credentials|log ?in/i.test(out)) {
      die('вход в Vercel не выполнен — запустите `npx vercel login` (кнопка «Continue with GitHub») и повторите');
    }
    die(`vercel завершился с кодом ${res.status}`);
  }
  return out;
}

async function check(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    return res.status;
  } catch (e) {
    return `нет ответа (${e.message})`;
  }
}

const domain = config.domain?.trim();

if (CHECK_ONLY) {
  if (!domain) die('домен ещё не задан в site/site.config.json — сначала выполните деплой');
  const status = await check(`https://${domain}`);
  console.log(`https://${domain} → ${status}`);
  process.exitCode = status === 200 ? 0 : 1;
} else {
  // 1. Сборка
  const out = run(['deploy', '--prod', '--yes']);
  const match = out.match(/https:\/\/[^\s]+\.vercel\.app/g);
  if (!match) die('не удалось выцепить URL сборки из вывода vercel');
  const deployUrl = match[match.length - 1];
  console.log(`\nсборка: ${deployUrl}`);

  // 2. Домен на эту сборку
  let target = domain;
  if (!target) {
    // Первый деплой: постоянный домен проекта = <проект>.vercel.app.
    target = deployUrl.replace(/^https:\/\//, '').replace(/-[a-z0-9]+-[a-z0-9-]+\.vercel\.app$/, '.vercel.app');
    console.log(`домен в конфиге пуст — беру ${target}`);
  }

  if (!NO_ALIAS) {
    run(['alias', 'set', deployUrl, target]);
    if (!domain) {
      config.domain = target;
      writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf8');
      console.log(`домен записан в site/site.config.json: ${target}`);
    }
    const status = await check(`https://${target}`);
    console.log(`\nпроверка: https://${target} → ${status}`);
    if (status !== 200) {
      console.error('домен не отдаёт 200 — не публикуйте воронку на этот адрес, пока не разберётесь');
      process.exitCode = 1;
    }
  }
}
