/* Loads the self-hosted pdf.js (4.x legacy build, patched for CVE-2024-4367) and exposes it to
   customer.js as window.pdfjsLib. Documents are always opened with isEvalSupported:false. */
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
window.pdfjsLib = pdfjsLib;
window.dispatchEvent(new Event('pdfjs-ready'));
