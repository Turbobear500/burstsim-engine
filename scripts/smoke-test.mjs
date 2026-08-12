/**
 * Дымовой тест WASM-сборки simc (F0-6).
 *
 * Повторяет ровно тот путь, что будет в продакшене: текст профиля кладётся
 * в виртуальную ФС модуля, движок запускается через callMain, отчёт json2
 * читается обратно из виртуальной ФС. Никакого доступа к реальным файлам —
 * значит в браузере это работает так же, как здесь.
 *
 * Запуск:  node burstsim/smoke-test.mjs <путь-к-профилю.simc> [итераций]
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { наборПрофиля, PROFILES } from './canary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(process.env.SIMC_DIR ?? 'E:/simc', 'build-wasm-mt');

const SIMC = process.env.SIMC_DIR ?? 'E:/simc'; // профили — часть апстрима, а не обвязки

/**
 * ⚠️ ИМЯ ПРОФИЛЯ БОЛЬШЕ НЕ ЗАШИТО ЗДЕСЬ (починено 2026-08-12).
 *
 * Стояло `MID1_Warrior_Arms`. Патч 12.1 перестроил деревья талантов, воин умер
 * целиком, набор канареек пересобрали — а этот скрипт остался прибит к
 * мертвецу и валил ночной конвейер каждую ночь на первом же шаге, ещё до
 * канареек. Имя профиля обязано жить в ОДНОМ месте: берём первый из общего
 * набора, второго списка нет по построению.
 *
 * Цена ошибки не в самом падении, а в привычке: гейт, который горит всегда,
 * перестают читать, и настоящая поломка проходит незамеченной.
 */
const имя = PROFILES[0];
const profilePath = process.argv[2] ?? resolve(SIMC, 'profiles', наборПрофиля(имя), `${имя}.simc`);
const iterations = process.argv[3] ?? '100';

/** Строка, после которой отчёта не будет никогда — та же, что в canary.mjs. */
const ФАТАЛЬНОЕ = /^\s*Error:|Initialization error/i;
let фатальная = null;

const profileText = readFileSync(profilePath, 'utf8');
console.log(`профиль: ${profilePath} (${profileText.length} байт), итераций: ${iterations}`);

// На Windows абсолютный путь нужно отдавать ESM-загрузчику как file:// URL.
const factory = (await import(pathToFileURL(resolve(buildDir, 'simc.js')).href)).default;

const t0 = Date.now();
let exitCode = null;
let resolveExit;
// С -sPROXY_TO_PTHREAD main() уходит в отдельный поток: callMain возвращает
// управление сразу, поэтому завершение ждём через onExit.
const finished = new Promise((res) => {
  resolveExit = res;
});

const Module = await factory({
  noInitialRun: true,
  print: (line) => {
    if (!фатальная && ФАТАЛЬНОЕ.test(String(line))) фатальная = String(line);
    process.stdout.write(line + '\n');
  },
  printErr: (line) => {
    if (!фатальная && ФАТАЛЬНОЕ.test(String(line))) фатальная = String(line);
    process.stderr.write(line + '\n');
  },
  onExit: (code) => {
    exitCode = code;
    resolveExit();
  },
});

Module.FS.writeFile('/input.simc', profileText);

try {
  Module.callMain([
    '/input.simc',
    `iterations=${iterations}`,
    `threads=${process.env.SIMC_THREADS ?? '4'}`,
    'json2=/out.json',
    'html=',
    'report_details=0',
    ...process.argv.slice(4),
  ]);
} catch (err) {
  if (err?.name !== 'ExitStatus') throw err;
  exitCode = err.status ?? 0;
  resolveExit();
}

// EXIT_RUNTIME=0 держит рантайм живым (иначе виртуальная ФС исчезнет вместе с
// отчётом), поэтому onExit может не наступить. Надёжный сигнал готовности —
// появление файла json2 в виртуальной ФС. Ровно так же будет делать браузерная обвязка.
const deadline = Date.now() + 600_000;
let ready = false;
while (Date.now() < deadline) {
  // ⚠️ БЫСТРЫЙ ОТКАЗ (заведено 2026-08-12, по образцу canary.mjs). Движок
  // сообщает фатальную ошибку СРАЗУ — отчёта после неё не будет никогда, и
  // ждать полный таймаут бессмысленно. На патче 12.1 ночной конвейер из-за
  // этого стоял десять минут молча, а потом падал по таймауту вместо того,
  // чтобы за секунду назвать настоящую причину.
  if (фатальная) break;

  try {
    Module.FS.stat('/out.json');
    ready = true;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
if (фатальная) {
  // Причина названа движком — печатаем её, а не «таймаут». Диагноз по такой
  // строке ставится за секунды; таблица «чей это отказ» — в навыке /patch-day.
  throw new Error(`движок отказался считать: ${фатальная.trim()}`);
}
if (!ready) throw new Error('таймаут: отчёт json2 не появился за 10 мин');
await Promise.race([finished, new Promise((r) => setTimeout(r, 1000))]);

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

let dps = null;
try {
  const report = JSON.parse(Module.FS.readFile('/out.json', { encoding: 'utf8' }));
  const player = report?.sim?.players?.[0];
  dps = player?.collected_data?.dps?.mean ?? null;
  console.log(`\nигрок: ${player?.name ?? '?'} (${player?.specialization ?? '?'})`);
} catch (err) {
  console.error(`не удалось прочитать json2: ${err.message}`);
}

console.log(`DPS: ${dps === null ? 'НЕ ПОЛУЧЕН' : Math.round(dps).toLocaleString('ru-RU')}`);
console.log(`время: ${elapsed} с, код выхода: ${exitCode}`);

process.exit(dps === null ? 1 : 0);
