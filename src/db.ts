import { PrismaClient } from '@prisma/client';

// Create a single instance of PrismaClient
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

// Handle cleanup on app termination
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});