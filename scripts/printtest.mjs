// Isolated check: can pdf-to-printer silently drive "PrintQ Test PDF"?
import ptp from 'pdf-to-printer';
const [pdf, printer] = process.argv.slice(2);
console.log('printing', pdf, '->', printer);
await ptp.print(pdf, { printer });
console.log('print() returned OK');
