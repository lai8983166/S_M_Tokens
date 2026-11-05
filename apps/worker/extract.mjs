import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
// Parsing happens in a disposable thread with a wall-clock and heap limit.
try {
  const { path, pdf } = workerData;
  let text = '';
  if (pdf) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({
      data: new Uint8Array(await readFile(path)),
      useSystemFonts: false,
      disableFontFace: true,
    });
    const document = await loading.promise;
    if (document.numPages > 500) throw new Error('PDF 超过第一版 500 页解析上限');
    for (let page = 1; page <= document.numPages; page++) {
      const content = await (await document.getPage(page)).getTextContent();
      text += `\n[第 ${page} 页]\n` + content.items.map((item) => item.str ?? '').join(' ');
      if (text.length > 2_000_000) throw new Error('文件解析内容超过第一版输入上限，请拆分文件');
    }
    await loading.destroy();
    if (!text.trim()) throw new Error('PDF 没有可提取文字，第一版不支持 OCR');
  } else {
    const buffer = await readFile(path);
    if (buffer.length > 8_000_000) throw new Error('文本文件超过第一版直接读取上限，请拆分文件');
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new Error('文本文件需要 UTF-8 编码');
    }
    if (text.includes('\0')) throw new Error('此文件不是可读取的文本');
    if (text.length > 2_000_000) throw new Error('文件解析内容超过第一版输入上限，请拆分文件');
  }
  parentPort?.postMessage({ text });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : '文件解析失败' });
}
