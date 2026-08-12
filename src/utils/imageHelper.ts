export function safeCreateObjectURL(blob: any): string {
  if (!blob) return '';
  if (typeof blob === 'string') return blob;
  if (blob instanceof Blob && blob.size > 0) {
    try {
      return URL.createObjectURL(blob);
    } catch {
      return '';
    }
  }
  return '';
}

export function getRefImageUrl(ref: any): string {
  if (!ref) return '';
  if (typeof ref === 'string') return ref;
  if (ref.dataUrl && typeof ref.dataUrl === 'string') return ref.dataUrl;
  if (ref.thumbnailUrl && typeof ref.thumbnailUrl === 'string') return ref.thumbnailUrl;
  if (ref.url && typeof ref.url === 'string') return ref.url;
  if (ref.blob && ref.blob instanceof Blob && ref.blob.size > 0) {
    try {
      return URL.createObjectURL(ref.blob);
    } catch {
      return '';
    }
  }
  return '';
}

export async function refToBlob(ref: any): Promise<Blob | null> {
  if (!ref) return null;
  if (ref.blob && ref.blob instanceof Blob && ref.blob.size > 0) {
    return ref.blob;
  }
  const url = getRefImageUrl(ref);
  if (url && url.startsWith('data:')) {
    try {
      const arr = url.split(',');
      const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      return new Blob([u8arr], { type: mime });
    } catch {
      return null;
    }
  }
  return null;
}
