const path = require('node:path');
const dotenv = require('dotenv');
const { hash } = require('bcryptjs');
const { PrismaPg } = require('@prisma/adapter-pg');
const {
  PrismaClient,
} = require('../dist/generated/prisma/client.js');

dotenv.config({
  path: path.resolve(__dirname, '../.env'),
});

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const email = (
    process.env.ADMIN_EMAIL || 'admin@psop.local'
  ).trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const name =
    process.env.ADMIN_NAME || 'PSOP Administrator';

  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  if (!password || password.length < 12) {
    throw new Error(
      'ADMIN_PASSWORD must contain at least 12 characters',
    );
  }

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    const organization =
      await prisma.organization.findFirst({
        where: {
          status: 'ACTIVE',
          deletedAt: null,
        },
        orderBy: {
          createdAt: 'asc',
        },
      });

    if (!organization) {
      throw new Error(
        'No active organization was found',
      );
    }

    const passwordHash = await hash(password, 12);

    const user = await prisma.user.upsert({
      where: { email },
      update: {
        organizationId: organization.id,
        name,
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
        deletedAt: null,
      },
      create: {
        organizationId: organization.id,
        name,
        email,
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });

    console.log(
      `Administrator ready: ${user.email} (${organization.name})`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
