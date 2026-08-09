// Native stub — web 裁剪（react-easy-crop，DOM-only）不进 native bundle。Metro 在 web 解析
// crop-modal.web.tsx，native / tsc 解析本文件。native 选图走 expo-image-picker 内建裁剪
// （allowsEditing），永不打开本 modal，故 stub 返回 null。props 形态须与 .web.tsx 一致。
export interface CropModalProps {
  visible: boolean;
  imageSrc: string | null;
  aspect: number;
  onConfirm: (blob: Blob) => void;
  onCancel: () => void;
}

export function CropModal(_props: CropModalProps) {
  return null;
}
