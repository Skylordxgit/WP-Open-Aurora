import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { omegaApi, type OmegaClient } from '../api';

type ClientFormState = Pick<
  OmegaClient,
  'companyName' | 'ownerName' | 'email' | 'phone' | 'status' | 'monthlyMessageLimit' | 'whatsappAccountLimit'
> & {
  planId: string;
};

const initialState: ClientFormState = {
  companyName: '',
  ownerName: '',
  email: '',
  phone: '',
  status: 'active',
  planId: '',
  monthlyMessageLimit: 0,
  whatsappAccountLimit: 1,
};

export function OmegaClientForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ClientFormState>(initialState);

  const { data: plans = [] } = useQuery({ queryKey: ['omega-plans'], queryFn: omegaApi.plans });
  const { data: client } = useQuery({
    queryKey: ['omega-client', id],
    queryFn: () => omegaApi.client(id!),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!client) return;
    setForm({
      companyName: client.companyName,
      ownerName: client.ownerName,
      email: client.email,
      phone: client.phone,
      status: client.status,
      planId: client.planId ?? '',
      monthlyMessageLimit: client.monthlyMessageLimit,
      whatsappAccountLimit: client.whatsappAccountLimit,
    });
  }, [client]);

  const mutation = useMutation({
    mutationFn: async () =>
      isEdit
        ? omegaApi.updateClient(id!, { ...form, planId: form.planId || null })
        : omegaApi.createClient({ ...form, planId: form.planId || undefined }),
    onSuccess: result => {
      void queryClient.invalidateQueries({ queryKey: ['omega-clients'] });
      void queryClient.invalidateQueries({ queryKey: ['omega-dashboard'] });
      navigate(`/clients/${result.id}`);
    },
  });

  return (
    <div className="omega-page">
      <div className="omega-page-actions">
        <div>
          <h2>{isEdit ? 'Edit Client' : 'Add Client'}</h2>
          <p>Configure company ownership, subscription limits, and current SaaS status.</p>
        </div>
        <Link className="omega-ghost-button" to="/clients">
          Back to Clients
        </Link>
      </div>

      <form
        className="omega-card omega-form omega-form-grid"
        onSubmit={event => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          <span>Company Name</span>
          <input value={form.companyName} onChange={event => setForm({ ...form, companyName: event.target.value })} />
        </label>
        <label>
          <span>Owner Name</span>
          <input value={form.ownerName} onChange={event => setForm({ ...form, ownerName: event.target.value })} />
        </label>
        <label>
          <span>Email</span>
          <input type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} />
        </label>
        <label>
          <span>Phone</span>
          <input value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })} />
        </label>
        <label>
          <span>Status</span>
          <select
            value={form.status}
            onChange={event => setForm({ ...form, status: event.target.value as ClientFormState['status'] })}
          >
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </label>
        <label>
          <span>Plan</span>
          <select
            value={form.planId}
            onChange={event => {
              const selected = plans.find(plan => plan.id === event.target.value);
              setForm({
                ...form,
                planId: event.target.value,
                monthlyMessageLimit: selected?.monthlyMessageLimit ?? form.monthlyMessageLimit,
                whatsappAccountLimit: selected?.whatsappAccountLimit ?? form.whatsappAccountLimit,
              });
            }}
          >
            <option value="">Custom / No plan</option>
            {plans.map(plan => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Monthly Message Limit</span>
          <input
            type="number"
            value={form.monthlyMessageLimit}
            onChange={event => setForm({ ...form, monthlyMessageLimit: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>WhatsApp Account Limit</span>
          <input
            type="number"
            value={form.whatsappAccountLimit}
            onChange={event => setForm({ ...form, whatsappAccountLimit: Number(event.target.value) })}
          />
        </label>

        {mutation.error && <div className="omega-inline-error">{(mutation.error as Error).message}</div>}
        <div className="omega-form-actions">
          <button className="omega-primary-button" type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Client'}
          </button>
        </div>
      </form>
    </div>
  );
}
