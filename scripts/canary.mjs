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

  // ⚠️ ВЫВОД ДВИЖКА НЕ ВЫБРАСЫВАЕМ, А КОПИМ ХВОСТОМ (2026-08-09).
  // Раньше print/printErr были заглушены наглухо, и при аварийном завершении
  // гейт сообщал «json2 не дочитался: [object Object]» — то есть «упало,
  // разбирайся сам». На патч-дне это худшее из возможных сообщений: причина
  // была у нас в руках и мы её выбросили. Тихий прогон остаётся тихим —
  // хвост печатается ТОЛЬКО когда профиль не дал отчёта.
  const хвост = [];
  const запомнить = (s) => {
    хвост.push(String(s));
    if (хвост.length > 12) хвост.shift();
  };
  const Module = await factory({ noInitialRun: true, print: запомнить, printErr: запомнить });

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
    if (err?.name !== 'ExitStatus') return { name, error: `${опишиОшибку(err)}${приписатьХвост(хвост)}` };
  }

  // ⚠️ Ждём не ПОЯВЛЕНИЯ файла, а момента, когда он ДОЧИТЫВАЕТСЯ как JSON
  // (починено 2026-08-08: гонка выстрелила на репетиции учений). Движок под
  // PROXY_TO_PTHREAD пишет отчёт из другого потока, и «файл существует» не
  // значит «файл дописан»: чтение в этот зазор давало «Unexpected end of JSON
  // input» — флаки, который выглядел как аварийное завершение движка.
  const ЖДЁМ_С = Number(process.env.CANARY_REPORT_TIMEOUT_S ?? 600);
  const deadline = Date.now() + ЖДЁМ_С * 1000;
  let lastError = `отчёт не появился за ${ЖДЁМ_С} с`;
  while (Date.now() < deadline) {
    try {
      const report = JSON.parse(Module.FS.readFile('/out.json', { encoding: 'utf8' }));
      const player = report?.sim?.players?.[0];
      const dps = Math.round(player?.collected_data?.dps?.mean ?? 0);
      // ⚠️ ИМЯ ПОЛЯ ОБЯЗАНО СОВПАДАТЬ С ТЕМ, ЧТО В НЁМ ЛЕЖИТ. Раньше здесь
      // стояло `error_pct`, а записывалось `mean_std_dev` — абсолютное
      // отклонение в DPS. В базовой линии это выглядело как «error_pct:
      // 237.32», то есть прибор в патч-день показывал 237% ошибки там, где
      // её 0,22%. На сверку это не влияло (сравниваются только dps), но
      // читать такое в два часа ночи — верный способ принять неверное
      // решение. Теперь пишем оба: абсолютное и настоящий процент.
      const std = Number((player?.collected_data?.dps?.mean_std_dev ?? 0).toFixed(2));
      return {
        name,
        spec: player?.specialization ?? '?',
        dps,
        mean_std_dev: std,
        err_pct: dps > 0 ? Number(((std / dps) * 100).toFixed(3)) : 0,
        build: report?.version ?? '?',
        wow_build: report?.sim?.options?.dbc?.Live ?? report?.build_level ?? '?',
      };
    } catch (err) {
      lastError = опишиОшибку(err);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return { name, error: `отчёта нет за ${ЖДЁМ_С} с (${lastError})${приписатьХвост(хвост)}` };
}

/**
 * Человекочитаемое описание ошибки.
 *
 * ⚠️ `String(err)` на объекте ошибки Emscripten даёт «[object Object]» — именно
 * так гейт 2026-08-09 сообщил о падении Unholy DK, не сказав ничего. Отдельная
 * ветка для ENOENT: «файла нет» и «файл не дочитан как JSON» — разные диагнозы,
 * и путать их нельзя (первое = движок не дошёл до записи, второе = гонка).
 */
function опишиОшибку(err) {
  if (err == null) return 'без описания';
  if (typeof err === 'string') return err;
  if (err.name === 'ErrnoError' || err.errno !== undefined) {
    return err.errno === 44 || err.code === 'ENOENT' ? 'файла отчёта нет' : `ошибка ФС (errno ${err.errno})`;
  }
  if (err.message) return `${err.name ?? 'Error'}: ${err.message}`;
  // ⚠️ Последний рубеж: у объекта без message String() даёт «[object Object]» —
  // ровно та бесполезная строка, из-за которой эта функция и появилась.
  const s = String(err);
  if (s !== '[object Object]') return s;
  try {
    return `объект без message: ${JSON.stringify(err)}`;
  } catch {
    return `объект без message (несериализуемый), ключи: ${Object.keys(err).join(',') || 'нет'}`;
  }
}

/** Последние строки самого движка — то, ради чего их и копили. */
function приписатьХвост(хвост) {
  if (!хвост.length) return ' · движок не сказал ничего';
  return `\n      движок напоследок: ${хвост.slice(-6).join(' | ')}`;
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

// Смена игрового билда — отдельный сигнал (docs/02 §4): патчевые качели DPS
// легитимны, но требуют РУЧНОГО аппрува, а не молчаливого сравнения яблок
// с грушами. После аппрува базовая линия переснимается (--record).
const wowБыло = base.results.find((r) => r.wow_build)?.wow_build?.wow_version ?? null;
const wowСтало = results.find((r) => r.wow_build)?.wow_build?.wow_version ?? null;
if (wowБыло !== wowСтало) {
  console.log(`⚠️ БИЛД ИГРЫ СМЕНИЛСЯ: ${wowБыло} → ${wowСтало}`);
  console.log('   Дрейф ниже ОЖИДАЕМ. Порядок: ручной аппрув по changelog апстрима,');
  console.log('   затем переснять базовую линию: node scripts/canary.mjs --record\n');
}

// ⚠️ РЕГРЕССИЯ ЖИВУЧЕСТИ ВАЛИТ ГЕЙТ (закрыто 2026-08-08). Прежний вердикт
// считал только дрейф сравнимых профилей: сборка, в которой упали ВСЕ
// двенадцать, печатала «дрейф 0,00% — можно промоутить». Профиль, живой в
// базовой линии и мёртвый сейчас, — это hard fail (docs/02 §4), а не пропуск.
let worst = 0;
const умерли = [];
for (const now of results) {
  const before = base.results.find((b) => b.name === now.name);
  if (now.error && before && !before.error) {
    console.log(`  ${now.name.padEnd(32)} был жив (${before.dps} DPS) → ${now.error}`);
    умерли.push(now.name);
    continue;
  }
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
if (умерли.length) {
  console.log(`❌ Регрессия живучести: ${умерли.length} проф. считали в базовой линии и упали сейчас — hard fail, промоушен запрещён.`);
  process.exit(1);
}
console.log(
  worst < 2
    ? 'Порог 2% не превышен — сборку можно промоутить.'
    : 'Порог превышен: нужно подтверждение из changelog апстрима, иначе карантин (docs/02 §4).',
);
process.exit(worst >= 5 ? 1 : 0);
}
