#!/usr/bin/env node
/**
 * КАНАРЕЙКИ: базовая линия DPS и обнаружение дрейфа между сборками движка.
 *
 * ЗАЧЕМ: в день патча надо отличить «движок обновился корректно» от
 * «движок сломался». Сравнивать можно только с зафиксированным «до» —
 * без базовой линии учения патч-дня не дают информации вообще.
 *
 * ЦЕНА ОШИБКИ: сломанный движок промоутится в прод и считает пользователям
 * неверные цифры. Доверие к числам — то единственное, что мы продаём.
 *
 * ЧЕСТНАЯ ГРАНИЦА: канарейки ловят ИЗМЕНЕНИЕ результата, но не отвечают,
 * правильное оно или нет. Дрейф из-за правки баланса и дрейф из-за бага
 * выглядят одинаково — различает их changelog апстрима, а не этот скрипт.
 * Сверка WASM с native (порог 0,5%) здесь не выполняется: native-сборка
 * заблокирована, см. decisions/DEAD-ENDS.md.
 *
 * Запуск:
 *   node burstsim/canary.mjs --record     снять базовую линию
 *   node burstsim/canary.mjs              сравнить с базовой линией
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SIMC_DIR ?? 'E:/simc'; // исходники апстрима лежат отдельно (ADR-0011)
const BUILD = join(ROOT, 'build-wasm-mt');
const BASELINE = resolve(HERE, '..', 'canary-baseline.json');

/**
 * Двенадцать профилей по ролям и архетипам (docs/02 §4).
 * Набор фиксирован: меняя состав, теряешь сравнимость с прежней линией.
 */
export const PROFILES = [
  'MID1_Warrior_Arms',           // ближний физический, 2H
  'MID1_Warrior_Protection',     // танк физический
  'MID1_Death_Knight_Unholy',    // ближний, питомец
  'MID1_Death_Knight_Blood',     // танк, самолечение
  'MID1_Rogue_Assassination',    // ближний, DoT
  'MID1_Monk_Windwalker',        // ближний, комбо
  'MID1_Hunter_Marksmanship',    // дальний физический
  'MID1_Mage_Frost',             // дальний магический, бурст
  'MID1_Warlock_Affliction',     // дальний, DoT-центричный
  'MID1_Priest_Shadow',          // дальний, ресурсный
  'MID1_Druid_Balance',          // дальний, циклы
  'MID1_Evoker_Devastation',     // дальний, эмпауэр
];

export const SEED = 4242;
export const ITERATIONS = 2000;
export const TARGET_ERROR = 0.5; // компромисс: 12 профилей должны укладываться в минуты

async function runProfile(name) {
  const profilePath = join(ROOT, 'profiles', 'MID1', `${name}.simc`);
  if (!existsSync(profilePath)) return { name, error: 'профиль не найден' };

  const factory = (await import(pathToFileURL(join(BUILD, 'simc.js')).href)).default;
  const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });

  Module.FS.writeFile('/in.simc', readFileSync(profilePath, 'utf8'));
  try {
    Module.callMain([
      '/in.simc',
      `iterations=${ITERATIONS}`,
      `target_error=${TARGET_ERROR}`,
      `seed=${SEED}`,
      'threads=8',
      'json2=/out.json',
      'html=',
      'report_details=0',
    ]);
  } catch (err) {
    if (err?.name !== 'ExitStatus') return { name, error: String(err?.message ?? err) };
  }

  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    try {
      Module.FS.stat('/out.json');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  try {
    const report = JSON.parse(Module.FS.readFile('/out.json', { encoding: 'utf8' }));
    const player = report?.sim?.players?.[0];
    return {
      name,
      spec: player?.specialization ?? '?',
      dps: Math.round(player?.collected_data?.dps?.mean ?? 0),
      error_pct: Number((player?.collected_data?.dps?.mean_std_dev ?? 0).toFixed(2)),
      build: report?.version ?? '?',
      wow_build: report?.sim?.options?.dbc?.Live ?? report?.build_level ?? '?',
    };
  } catch (err) {
    return { name, error: `json2 не прочитан: ${String(err)}` };
  }
}

// ── Прогон стартует ТОЛЬКО при прямом запуске файла ─────────────────────────
// ⚠️ Найдено 2026-08-08 на живом отказе: compare-native.mjs импортировал отсюда
// PROFILES — и импорт ИСПОЛНИЛ весь скрипт. Прогнались WASM-канарейки, скрипт
// вышел через process.exit, до кода сверки дело не дошло, а код выхода был 0 и
// вывод выглядел правдоподобно: «сверка с нативом» оказалась бы сравнением WASM
// с самим собой. Скрипт, который можно импортировать, не имеет права исполнять
// работу на верхнем уровне модуля.
if (fileURLToPath(import.meta.url) !== resolve(process.argv[1] ?? '')) {
  // Импорт ради PROFILES/SEED/… — отдаём экспорты и не считаем ничего.
} else {
  await canaryMain();
}

async function canaryMain() {
// ── Режим одного профиля: используется родителем как дочерний процесс ───────
// Каждый профиль считается в СВОЁМ процессе. Причина не в чистоте, а в том,
// что движок умеет аварийно завершаться на отдельном профиле (см. DEAD-ENDS):
// в общем процессе такой профиль убивал бы весь прогон канареек.
const oneIndex = process.argv.indexOf('--one');
if (oneIndex !== -1) {
  const name = process.argv[oneIndex + 1];
  const r = await runProfile(name);
  process.stdout.write('\n@@RESULT@@' + JSON.stringify(r) + '\n');
  process.exit(0);
}

const record = process.argv.includes('--record');
const results = [];

for (const [i, name] of PROFILES.entries()) {
  process.stdout.write(`[${i + 1}/${PROFILES.length}] ${name} … `);
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--one', name], {
    encoding: 'utf8',
    timeout: 900_000,
  });
  const marker = (child.stdout ?? '').split('@@RESULT@@')[1];
  let r;
  if (marker) {
    r = JSON.parse(marker.trim());
  } else {
    // Процесс умер, не отдав результата — это и есть аварийное завершение движка.
    r = { name, error: `движок аварийно завершился (код ${child.status ?? 'нет'})` };
  }
  results.push(r);
  process.stdout.write(r.error ? `ОШИБКА: ${r.error}\n` : `${r.dps.toLocaleString('ru-RU')} DPS\n`);
}

const failed = results.filter((r) => r.error);

if (record) {
  writeFileSync(
    BASELINE,
    JSON.stringify({ seed: SEED, iterations: ITERATIONS, target_error: TARGET_ERROR, recorded: new Date().toISOString().slice(0, 10), results }, null, 2) + '\n',
  );
  console.log(`\nБазовая линия записана: ${BASELINE}`);
  console.log(`Профилей: ${results.length}, из них с ошибкой: ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

if (!existsSync(BASELINE)) {
  console.error('\nБазовой линии нет. Снять: node burstsim/canary.mjs --record');
  process.exit(1);
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
console.log('\nДрейф относительно базовой линии от ' + base.recorded + ':\n');

let worst = 0;
for (const now of results) {
  const before = base.results.find((b) => b.name === now.name);
  if (!before || before.error || now.error) {
    console.log(`  ${now.name}: сравнение невозможно`);
    continue;
  }
  const drift = ((now.dps - before.dps) / before.dps) * 100;
  worst = Math.max(worst, Math.abs(drift));
  const mark = Math.abs(drift) < 2 ? 'ок' : Math.abs(drift) < 5 ? 'ВНИМАНИЕ' : 'КАРАНТИН';
  console.log(
    `  ${now.name.padEnd(32)} ${String(before.dps).padStart(8)} → ${String(now.dps).padStart(8)}  ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}%  ${mark}`,
  );
}

console.log(`\nМаксимальный дрейф: ${worst.toFixed(2)}%`);
console.log(
  worst < 2
    ? 'Порог 2% не превышен — сборку можно промоутить.'
    : 'Порог превышен: нужно подтверждение из changelog апстрима, иначе карантин (docs/02 §4).',
);
process.exit(worst >= 5 ? 1 : 0);
}
