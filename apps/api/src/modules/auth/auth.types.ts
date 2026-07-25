import type { Request } from 'express';

export interface AuthUser {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER';
}

export interface JwtPayload {
  sub: string;
  organizationId: string;
  email: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER';
}

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}
