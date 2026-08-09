import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOmegaSaasTables1782000000000 implements MigrationInterface {
  name = 'CreateOmegaSaasTables1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "omega_users" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"fullName" varchar(120) NOT NULL, ` +
        `"email" varchar(180) NOT NULL, ` +
        `"passwordHash" varchar(255) NOT NULL, ` +
        `"clientId" varchar(36), ` +
        `"role" varchar(30) NOT NULL DEFAULT ('client_agent'), ` +
        `"status" varchar(20) NOT NULL DEFAULT ('active'), ` +
        `"lastLoginAt" datetime, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_omega_users_email" ON "omega_users" ("email")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "omega_clients" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"companyName" varchar(180) NOT NULL, ` +
        `"ownerName" varchar(120) NOT NULL, ` +
        `"email" varchar(180) NOT NULL, ` +
        `"phone" varchar(40) NOT NULL, ` +
        `"status" varchar(20) NOT NULL DEFAULT ('active'), ` +
        `"planId" varchar(36), ` +
        `"monthlyMessageLimit" integer NOT NULL DEFAULT (0), ` +
        `"whatsappAccountLimit" integer NOT NULL DEFAULT (1), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_omega_clients_companyName" ON "omega_clients" ("companyName")`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_omega_clients_email" ON "omega_clients" ("email")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "omega_plans" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"name" varchar(120) NOT NULL, ` +
        `"description" varchar(400), ` +
        `"monthlyMessageLimit" integer NOT NULL DEFAULT (0), ` +
        `"whatsappAccountLimit" integer NOT NULL DEFAULT (1), ` +
        `"monthlyPrice" float NOT NULL DEFAULT (0), ` +
        `"features" text NOT NULL DEFAULT ('[]'), ` +
        `"isActive" boolean NOT NULL DEFAULT (1), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_omega_plans_name" ON "omega_plans" ("name")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "omega_whatsapp_sessions" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"openwaSessionId" varchar(120) NOT NULL, ` +
        `"clientId" varchar(36), ` +
        `"phoneNumber" varchar(40), ` +
        `"status" varchar(30) NOT NULL DEFAULT ('disconnected'), ` +
        `"assignedToClient" boolean NOT NULL DEFAULT (0), ` +
        `"lastSeenAt" datetime, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_omega_whatsapp_sessions_openwaSessionId" ` +
        `ON "omega_whatsapp_sessions" ("openwaSessionId")`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "omega_contacts" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"clientId" varchar(36) NOT NULL, ` +
        `"name" varchar(160) NOT NULL, ` +
        `"phoneNumber" varchar(40) NOT NULL, ` +
        `"email" varchar(180), ` +
        `"metadata" text NOT NULL DEFAULT ('{}'), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "omega_contact_groups" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"clientId" varchar(36) NOT NULL, ` +
        `"name" varchar(120) NOT NULL, ` +
        `"description" varchar(300), ` +
        `"contactCount" integer NOT NULL DEFAULT (0), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "omega_campaigns" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"clientId" varchar(36) NOT NULL, ` +
        `"name" varchar(160) NOT NULL, ` +
        `"status" varchar(30) NOT NULL DEFAULT ('draft'), ` +
        `"scheduledAt" datetime, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "omega_campaign_recipients" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"campaignId" varchar(36) NOT NULL, ` +
        `"contactId" varchar(36), ` +
        `"phoneNumber" varchar(40) NOT NULL, ` +
        `"status" varchar(30) NOT NULL DEFAULT ('pending'), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "omega_messages" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"clientId" varchar(36) NOT NULL, ` +
        `"sessionId" varchar(36), ` +
        `"campaignId" varchar(36), ` +
        `"recipient" varchar(40) NOT NULL, ` +
        `"direction" varchar(20) NOT NULL DEFAULT ('outbound'), ` +
        `"status" varchar(20) NOT NULL DEFAULT ('queued'), ` +
        `"body" text NOT NULL, ` +
        `"sentAt" datetime, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "omega_usage_logs" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"clientId" varchar(36) NOT NULL, ` +
        `"sessionId" varchar(36), ` +
        `"metricType" varchar(30) NOT NULL DEFAULT ('messages'), ` +
        `"units" integer NOT NULL DEFAULT (0), ` +
        `"periodMonth" varchar(7) NOT NULL, ` +
        `"metadata" text NOT NULL DEFAULT ('{}'), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "omega_subscriptions" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"clientId" varchar(36) NOT NULL, ` +
        `"planId" varchar(36) NOT NULL, ` +
        `"status" varchar(20) NOT NULL DEFAULT ('active'), ` +
        `"monthlyMessageLimit" integer NOT NULL DEFAULT (0), ` +
        `"whatsappAccountLimit" integer NOT NULL DEFAULT (1), ` +
        `"startsAt" datetime, ` +
        `"endsAt" datetime, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_omega_subscriptions_clientId" ON "omega_subscriptions" ("clientId")`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "omega_auth_sessions" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"userId" varchar(36) NOT NULL, ` +
        `"tokenHash" varchar(64) NOT NULL, ` +
        `"expiresAt" datetime NOT NULL, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_omega_auth_sessions_tokenHash" ` +
        `ON "omega_auth_sessions" ("tokenHash")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_omega_auth_sessions_tokenHash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "omega_auth_sessions"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_omega_subscriptions_clientId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "omega_subscriptions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "omega_usage_logs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "omega_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "omega_campaign_recipients"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "omega_campaigns"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "omega_contact_groups"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "omega_contacts"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_omega_whatsapp_sessions_openwaSessionId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "omega_whatsapp_sessions"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_omega_plans_name"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "omega_plans"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_omega_clients_email"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_omega_clients_companyName"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "omega_clients"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_omega_users_email"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "omega_users"`);
  }
}
