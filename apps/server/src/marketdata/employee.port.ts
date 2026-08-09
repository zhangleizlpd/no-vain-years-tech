import type { EmployeeDto, EmployeeRangeQuery } from './marketdata.types.js';

/**
 * 员工端口 (042 US3)。理杏仁 `${market}/company/employee` 主源 (指定证券各报告期员工数据:
 * dataList 展开为 {parentItemName, itemName, value, displayType} typed 子行, 报告期 metadata
 * date/declarationDate 反规范化到每行)。
 *
 * per-stock 区间抓取 (形态照抄营收构成 / buyback `getRange(from,to)`): 单只 symbol 拉 [from, to]
 * 报告期员工序列 (date 升序), 供 backfill 回填历史报告期 + delta 抓当期。理杏仁端点单数 stockCode
 * (数组 → 400, 同 041 事件流; **不用 metricsList** → 无 p1 #670 all-or-nothing 静默 0 行坑)。
 * vendor dataList 是「维度头行 + 数据行」混合结构 (plan Decision 3): adapter 跳纯头行 (无 parent +
 * 无 value)、顶层有 value 行 (员工总数/总流失率) parentItemName 落哨兵 '' 、key `.trim()` 归一。
 * **displayType (number/percentage) 进自然键** (plan Decision 6, probe 实证同名 (parent,item) 出
 * number+percentage 两行 —— 如「流失率按性别分‖男性」= {58812 number, 15.2 percentage}): 两行都出、
 * 不去重 (NK 含 displayType 才能共存)。无员工披露标的 → 空数组 (不崩)。
 */
export const EMPLOYEE_PORT = Symbol('EMPLOYEE_PORT');

export interface EmployeePort {
  /** per-stock 区间抓取: 单只 symbol 拉 [from, to] 报告期员工序列, date 升序; 无数据 → 空数组。 */
  getEmployeeRange(query: EmployeeRangeQuery): Promise<EmployeeDto[]>;
}
