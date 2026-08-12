export interface FirstFrameCheckResult {
  valid: boolean;
  format: string;
  mimeType: string;
  width?: number;
  height?: number;
  aspectRatioStr?: string;
  fileSizeBytes: number;
  hasAlphaChannel?: boolean;
  resolutionStatus: 'optimal' | 'low_resolution' | 'unknown';
  warnings: string[];
  errors: string[];
  firstFrameMode: '首帧模式：原图直通';
  identityQaStatus: '身份自动质检：未执行';
  masterImagesSentCount: 0;
}

export class FirstFrameChecker {
  public static checkBuffer(buffer: Buffer, mimeType?: string): FirstFrameCheckResult {
    const sizeBytes = buffer.length;
    const warnings: string[] = [];
    const errors: string[] = [];

    let format = 'unknown';
    let detectedMime = mimeType || 'image/jpeg';

    // Magic number inspection
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
      format = 'jpeg';
      detectedMime = 'image/jpeg';
    } else if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      format = 'png';
      detectedMime = 'image/png';
    } else if (buffer.length >= 12 && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
      format = 'webp';
      detectedMime = 'image/webp';
    } else {
      errors.push('不支持或受损的图像格式，仅支持 JPG、PNG、WebP 格式。');
    }

    if (sizeBytes > 20 * 1024 * 1024) {
      errors.push('首帧图片大小超过 20MB 限制。');
    }

    let width: number | undefined;
    let height: number | undefined;

    // Fast image size parser for PNG & JPEG
    if (format === 'png' && buffer.length >= 24) {
      width = buffer.readUInt32BE(16);
      height = buffer.readUInt32BE(20);
    } else if (format === 'jpeg') {
      let offset = 2;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xFF) break;
        const marker = buffer[offset + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          height = buffer.readUInt16BE(offset + 5);
          width = buffer.readUInt16BE(offset + 7);
          break;
        }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
    }

    let aspectRatioStr: string | undefined;
    let resolutionStatus: 'optimal' | 'low_resolution' | 'unknown' = 'unknown';

    if (width && height) {
      const ratio = width / height;
      aspectRatioStr = `${width}x${height} (${ratio.toFixed(2)})`;

      if (height < 1280 || width < 720) {
        resolutionStatus = 'low_resolution';
        warnings.push(`首帧分辨率 ${width}×${height} 低于标准的 720×1280，生成视频画面可能略显模糊。`);
      } else {
        resolutionStatus = 'optimal';
      }
    }

    // PNG Alpha channel heuristic
    let hasAlphaChannel = false;
    if (format === 'png' && buffer.length >= 26) {
      const colorType = buffer[25];
      if (colorType === 4 || colorType === 6) {
        hasAlphaChannel = true;
        warnings.push('首帧 PNG 图像包含 Alpha 透明通道，已自动保留不作黑底填充。');
      }
    }

    return {
      valid: errors.length === 0,
      format,
      mimeType: detectedMime,
      width,
      height,
      aspectRatioStr,
      fileSizeBytes: sizeBytes,
      hasAlphaChannel,
      resolutionStatus,
      warnings,
      errors,
      firstFrameMode: '首帧模式：原图直通',
      identityQaStatus: '身份自动质检：未执行',
      masterImagesSentCount: 0,
    };
  }

  public static checkDataUrl(dataUrl: string): FirstFrameCheckResult {
    try {
      const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        return {
          valid: false,
          format: 'unknown',
          mimeType: 'unknown',
          fileSizeBytes: 0,
          resolutionStatus: 'unknown',
          warnings: [],
          errors: ['无效的 Base64 图像 DataURL 格式'],
          firstFrameMode: '首帧模式：原图直通',
          identityQaStatus: '身份自动质检：未执行',
          masterImagesSentCount: 0,
        };
      }
      const mimeType = matches[1];
      const buffer = Buffer.from(matches[2], 'base64');
      return this.checkBuffer(buffer, mimeType);
    } catch {
      return {
        valid: false,
        format: 'unknown',
        mimeType: 'unknown',
        fileSizeBytes: 0,
        resolutionStatus: 'unknown',
        warnings: [],
        errors: ['首帧图像 DataURL 解析异常'],
        firstFrameMode: '首帧模式：原图直通',
        identityQaStatus: '身份自动质检：未执行',
        masterImagesSentCount: 0,
      };
    }
  }
}
