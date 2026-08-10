#!/usr/bin/env node
/**
 * СВЕРКА WASM ↔ NATIVE (F0-8) и разбор падающих профилей (F0-27).
 *
 * ЗАЧЕМ. Вердикт «WASM-сборка считает правильно» до сих пор не вынесен: мы
 * знаем только, что она считает ПОХОЖЕ на саму себя. Пока native не подтвердил
 * числа, браузерный лейн публиковать нельзя — мы показывали бы людям цифры, не
 * зная, верны ли они. Доверие к числам это единственное, что мы продаём.
 *
 * ЧТО ДЕЛАЕТ. Гоняет тот же набор профилей с теми же параметрами (набор
 * импортируется из canary.mjs — второго списка нет по построению) в нативном
 * контейнере и сравнивает с базовой линией WASM.
 *
 * ПОРОГ 0,5% — из docs/02 §4. Расхождение выше — это баг сборки, а не баланс:
 * seed, число итераций и target_error одинаковы, значит различаться числа могут
 * только из-за самой сборки.
 *
 * ⚠️ ЧЕТЫРЕ ПРОФИЛЯ РОНЯЮТ WASM (Blood DK, Mage Frost, Priest Shadow, Evoker
 * Devastation). Главный вопрос этого прогона — падает ли на них native:
 *  · падает тоже  → баг апстрима, ждём и сообщаем им;
 *  · не падает    → баг НАШЕЙ WASM-сборки, чинить нам, лейн держим закрытым.
 *
 * Запуск:  node scripts/compare-native.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ITERATIONS, PROFILES, SEED, TARGET_ERROR } from './canary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(HERE, '..', 'canary-baseline.json');
/**
 * Итог сверки в машинном виде.
 *
 * ⚠️ ЗАЧЕМ ФАЙЛ, А НЕ ТОЛЬКО ПЕЧАТЬ. Максимальное расхождение с нативом — это
 * число, которое сайт показывает людям («12/12 в пределах 0,21%»). Пока оно
 * жило только в выводе на экран, его переносили в код руками, а руками
 * переносимое число рано или поздно отстаёт от истины. Теперь его забирает
 * `pnpm sync:canaries` в основном репозитории.
 */
const ИТОГ_ФАЙЛ = resolve(HERE, '..', 'native-compare.json');
const ОБРАЗ = process.env.ENGINE_IMAGE ?? 'burstsim-engine:native';
const ПОРОГ = 0.5; // процент, docs/02 §4

/**
 * Профили лежат внутри образа: /profiles — часть апстрима, а не обвязки.
 *
 * ⚠️ Отчёт пишется в ФАЙЛ внутри контейнера, а наружу отдаётся только он.
 * Через `json2=/dev/stdout` движок смешивает JSON с текстовым отчётом в одном
 * потоке, и разбор ломается на первом же прогоне. Заодно так виден код выхода
 * самого движка, а не последней команды конвейера.
 */
function прогнать(name) {
  const команда =
    `simc /profiles/MID1/${name}.simc ` +
    `iterations=${ITERATIONS} target_error=${TARGET_ERROR} seed=${SEED} threads=8 ` +
    `json2=/tmp/o.json html= report_details=0 >/tmp/log 2>&1 || { tail -3 /tmp/log >&2; exit 42; }; ` +
    `cat /tmp/o.json`;

  const итог = spawnSync(
    'docker',
    ['run', '--rm', '--network=none', '--entrypoint', '/bin/sh', ОБРАЗ, '-c', команда],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );

  if (итог.error) return { name, error: `docker не запустился: ${итог.error.message}` };
  if (итог.status !== 0) {
    const хвост = (итог.stderr ?? '').trim().split('\n').slice(-2).join(' | ');
    return { name, error: `движок завершился с кодом ${итог.status}${хвост ? ': ' + хвост : ''}` };
  }

  try {
    const отчёт = JSON.parse(итог.stdout ?? '');
    const игрок = отчёт?.sim?.players?.[0];
    const dps = игрок?.collected_data?.dps?.mean;
    if (typeof dps !== 'number') return { name, error: 'в отчёте нет DPS' };
    return { name, dps };
  } catch (е) {
    return { name, error: `отчёт не разобрался: ${е.message}` };
  }
}

if (!existsSync(BASELINE)) {
  console.log(`Базовой линии нет: ${BASELINE}. Сначала снять её WASM-прогоном.`);
  process.exit(1);
}
const линия = JSON.parse(readFileSync(BASELINE, 'utf8'));
const wasm = new Map((линия.profiles ?? линия.results ?? []).map((p) => [p.name, p]));

console.log('\nСВЕРКА WASM ↔ NATIVE');
console.log(`образ ${ОБРАЗ} · seed ${SEED} · iterations ${ITERATIONS} · target_error ${TARGET_ERROR}%`);
console.log('─'.repeat(78));

const строки = [];
for (const [i, name] of PROFILES.entries()) {
  process.stdout.write(`[${i + 1}/${PROFILES.length}] ${name} … `);
  const н = прогнать(name);
  const в = wasm.get(name);
  const wasmDps = typeof в?.dps === 'number' ? в.dps : null;
  const wasmУпал = Boolean(в?.error) || wasmDps === null;

  if (н.error) {
    console.log(`native: ОШИБКА — ${н.error}`);
    строки.push({ name, вердикт: wasmУпал ? 'падают оба' : 'падает только native', детали: н.error });
    continue;
  }

  console.log(`${Math.round(н.dps)} DPS`);
  if (wasmУпал) {
    строки.push({ name, вердикт: 'падает только WASM', native: н.dps });
    continue;
  }
  const дельта = ((н.dps - wasmDps) / wasmDps) * 100;
  строки.push({
    name,
    вердикт: Math.abs(дельта) <= ПОРОГ ? 'сходится' : 'РАСХОЖДЕНИЕ',
    wasm: wasmDps,
    native: н.dps,
    дельта,
  });
}

console.log('\n' + '─'.repeat(78));
for (const с of строки) {
  const числа =
    с.дельта === undefined
      ? (с.native ? `native ${Math.round(с.native)}` : с.детали ?? '')
      : `${Math.round(с.wasm)} → ${Math.round(с.native)}  ${с.дельта >= 0 ? '+' : ''}${с.дельта.toFixed(2)}%`;
  console.log(`  ${с.name.padEnd(30)} ${с.вердикт.padEnd(22)} ${числа}`);
}

const расхождения = строки.filter((с) => с.вердикт === 'РАСХОЖДЕНИЕ');
const толькоWasm = строки.filter((с) => с.вердикт === 'падает только WASM');
const толькоNative = строки.filter((с) => с.вердикт === 'падает только native');
const обаПадают = строки.filter((с) => с.вердикт === 'падают оба');

console.log('\nИТОГ');
console.log(`  сошлось в пределах ${ПОРОГ}%: ${строки.filter((с) => с.вердикт === 'сходится').length}`);
if (расхождения.length) console.log(`  ❌ расхождений: ${расхождения.length} — это баг сборки, а не баланс`);
if (обаПадают.length) console.log(`  падают обе сборки: ${обаПадают.length} → баг апстрима, наша вина исключена`);
if (толькоWasm.length) console.log(`  ❌ падает только WASM: ${толькоWasm.length} → баг НАШЕЙ сборки, лейн держим закрытым`);
if (толькоNative.length) console.log(`  ⚠️ падает только native: ${толькоNative.length} → разбирать отдельно`);

const сошлись = строки.filter((с) => с.вердикт === 'сходится');
const максДельта = сошлись.reduce((m, с) => Math.max(m, Math.abs(с.дельта ?? 0)), 0);

writeFileSync(
  ИТОГ_ФАЙЛ,
  JSON.stringify(
    {
      _: 'Итог сверки WASM ↔ native. Пишется compare-native.mjs, читается pnpm sync:canaries в основном репозитории. Руками не править.',
      compared: new Date().toISOString().slice(0, 10),
      threshold_pct: ПОРОГ,
      converged: сошлись.length,
      total: строки.length,
      max_delta_pct: Number(максДельта.toFixed(2)),
      build: линия.results?.[0]?.build ?? null,
      wow_version: линия.results?.[0]?.wow_build?.wow_version ?? null,
    },
    null,
    2,
  ) + '\n',
);
console.log(`  итог записан: ${ИТОГ_ФАЙЛ} (максимум ${максДельта.toFixed(2)}%)`);

console.log('');
process.exit(расхождения.length || толькоWasm.length || толькоNative.length ? 1 : 0);
