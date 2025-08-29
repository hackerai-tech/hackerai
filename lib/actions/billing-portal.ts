'use server';

import { redirect } from 'next/navigation';
import { stripe } from '../../app/api/stripe';
import { workos } from '@/app/api/workos';
import { withAuth } from '@workos-inc/authkit-nextjs';

export default async function redirectToBillingPortal() {
  const { organizationId } = await withAuth();

  const response = await fetch(`${workos.baseURL}/organizations/${organizationId}`, {
    headers: {
      'Authorization': `Bearer ${process.env.WORKOS_API_KEY}`,
      'content-type': 'application/json',
    },
  });
  const workosOrg = await response.json();

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  const billingPortalSession = await stripe.billingPortal.sessions.create({
    customer: workosOrg?.stripe_customer_id,
    return_url: `${baseUrl}`,
  });

  redirect(billingPortalSession?.url);
}
