export enum OmegaUserRole {
  SUPER_ADMIN = 'super_admin',
  SUPPORT_ADMIN = 'support_admin',
  CLIENT_ADMIN = 'client_admin',
  CLIENT_AGENT = 'client_agent',
}

export enum OmegaUserStatus {
  ACTIVE = 'active',
  INVITED = 'invited',
  SUSPENDED = 'suspended',
}

export enum OmegaClientStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

export enum OmegaSessionStatus {
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  NEEDS_RECONNECT = 'needs_reconnect',
  STARTING = 'starting',
  QR_REQUIRED = 'qr_required',
}

export enum OmegaSubscriptionStatus {
  ACTIVE = 'active',
  TRIAL = 'trial',
  PAST_DUE = 'past_due',
  CANCELED = 'canceled',
}

export enum OmegaCampaignStatus {
  DRAFT = 'draft',
  SCHEDULED = 'scheduled',
  SENT = 'sent',
}

export enum OmegaCampaignRecipientStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
}

export enum OmegaMessageDirection {
  OUTBOUND = 'outbound',
  INBOUND = 'inbound',
}

export enum OmegaMessageStatus {
  QUEUED = 'queued',
  SENT = 'sent',
  FAILED = 'failed',
  READ = 'read',
}

export enum OmegaUsageMetricType {
  MESSAGES = 'messages',
  SESSION_REPLACEMENT = 'session_replacement',
  RECONNECT = 'reconnect',
}
