import { workos } from "@/app/api/workos";

interface WorkOSAuthFactorResponse {
  id: string;
  type: string;
  created_at: string;
  updated_at: string;
  totp?: {
    issuer?: string;
    user?: string;
  };
}

interface WorkOSAuthFactorsListResponse {
  data: WorkOSAuthFactorResponse[];
}

export interface MfaFactor {
  id: string;
  type: string;
  issuer?: string;
  user?: string;
  createdAt: string;
  updatedAt: string;
}

export async function listUserMfaFactors(userId: string): Promise<MfaFactor[]> {
  const { data } = await workos.get<WorkOSAuthFactorsListResponse>(
    `/user_management/users/${encodeURIComponent(userId)}/auth_factors`,
    {
      query: { order: "desc" },
    },
  );

  return data.data.map((factor) => ({
    id: factor.id,
    type: factor.type,
    issuer: factor.totp?.issuer,
    user: factor.totp?.user,
    createdAt: factor.created_at,
    updatedAt: factor.updated_at,
  }));
}
