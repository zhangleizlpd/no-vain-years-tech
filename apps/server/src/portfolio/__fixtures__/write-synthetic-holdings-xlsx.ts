/**
 * 重生成 `synthetic-holdings.xlsx` (纯合成，数据集见 `synthetic-holdings.ts`)。
 *
 *   pnpm exec tsx apps/server/src/portfolio/__fixtures__/write-synthetic-holdings-xlsx.ts
 *
 * exceljs 写入含时间戳 ⇒ 每次重生成字节不同、解析内容相同；改数据集后必须重跑并提交产物，
 * 否则 `holdings-xlsx.parser.spec.ts` 的「入库文件 = 生成器产物」用例红。
 */
import { writeFile } from 'node:fs/promises';
import { SYNTHETIC_HOLDINGS_XLSX_PATH, buildSyntheticHoldingsXlsx } from './synthetic-holdings';

void (async () => {
  await writeFile(SYNTHETIC_HOLDINGS_XLSX_PATH, await buildSyntheticHoldingsXlsx());
  process.stdout.write(`wrote ${SYNTHETIC_HOLDINGS_XLSX_PATH}\n`);
})();
