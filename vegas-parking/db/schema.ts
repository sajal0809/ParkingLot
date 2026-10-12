import {sqliteTable,text,integer} from 'drizzle-orm/sqlite-core';
export const spots=sqliteTable('spots',{id:text('id').primaryKey(),status:text('status').notNull().default('available'),bookingId:text('booking_id'),owner:text('owner'),name:text('name'),vehicle:text('vehicle'),createdAt:integer('created_at'),version:integer('version').notNull().default(0),mutationId:text('mutation_id')});
export const events=sqliteTable('events',{id:text('id').primaryKey(),spotId:text('spot_id').notNull(),action:text('action').notNull(),createdAt:integer('created_at').notNull()});
export const paymentRequests=sqliteTable('payment_requests',{
 id:text('id').primaryKey(),spotId:text('spot_id').notNull(),owner:text('owner').notNull(),
 status:text('status').notNull().default('pending'),amountPaise:integer('amount_paise').notNull().default(1500),
 submittedRef:text('submitted_ref'),receiptRef:text('receipt_ref').unique(),passCode:text('pass_code').unique(),
 verifiedBy:text('verified_by'),verifiedAt:integer('verified_at'),createdAt:integer('created_at').notNull(),
 issueStatus:text('issue_status'),issueNote:text('issue_note'),issueResolution:text('issue_resolution'),
 lifecycle:text('lifecycle').notNull().default('active'),note:text('note'),
});
