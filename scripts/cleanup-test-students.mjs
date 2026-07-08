// Remove throwaway student accounts created by verification scripts, by phone.
// Usage: node scripts/cleanup-test-students.mjs +919000000091 +919000000092
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const phones = process.argv.slice(2);
const students = await prisma.student.findMany({ where: { phone: { in: phones } } });
for (const s of students) {
  await prisma.uploadedFile.deleteMany({ where: { studentId: s.id } });
  await prisma.student.delete({ where: { id: s.id } });
  console.log('removed test student', s.phone);
}
await prisma.$disconnect();
