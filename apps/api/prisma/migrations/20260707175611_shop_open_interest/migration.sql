-- CreateTable
CREATE TABLE "ShopOpenInterest" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopOpenInterest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopOpenInterest_shopId_studentId_key" ON "ShopOpenInterest"("shopId", "studentId");

-- AddForeignKey
ALTER TABLE "ShopOpenInterest" ADD CONSTRAINT "ShopOpenInterest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopOpenInterest" ADD CONSTRAINT "ShopOpenInterest_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
