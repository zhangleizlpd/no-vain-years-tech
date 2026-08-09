// web 选 xlsx：命令式 DOM `<input type=file>`（RN-web 无原生 input，镜像 profile-image
// use-profile-image-editor pickWebFile）。取消检测靠 window focus 回弹延一拍 —— 文件选择器
// 关闭时无 onchange，不处理会让 promise 永挂、忙态闸锁死。
import type { PickedHoldingsFile } from './use-holdings-import';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function pickHoldingsFile(): Promise<PickedHoldingsFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `.xlsx,${XLSX_MIME}`;
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const finish = (result: PickedHoldingsFile | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(result);
    };
    // 选择器关闭 → 窗口重获焦点；延一拍若 onchange 未先触发即视为取消（File 已选则 onchange 先 settle）。
    const onFocus = () => {
      setTimeout(() => finish(null), 350);
    };

    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      finish(file ? { file, filename: file.name } : null);
    };
    window.addEventListener('focus', onFocus);
    input.click();
  });
}
