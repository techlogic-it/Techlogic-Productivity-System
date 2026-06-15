import { useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import portalApi from './portalApi';

// Invitee landing page: redeem the invite token (from the link an admin sent) and
// set a password. On success they sign in normally. Also serves password resets.
export default function PortalAcceptInvite() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 10) return setError('Password must be at least 10 characters');
    if (password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      await portalApi.post('/auth/accept-invite', { token, password });
      setDone(true);
      setTimeout(() => navigate('/portal/login'), 1800);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not set your password — the link may have expired.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
      <div className="w-full max-w-sm bg-white rounded-xl shadow-sm border border-gray-200 p-8">
        <div className="mb-6 text-center">
          <div className="text-2xl font-bold text-gray-800">Techlogic Productivity System</div>
          <div className="text-sm text-gray-500 mt-1">Set your password</div>
        </div>

        {!token ? (
          <div className="text-sm text-gray-600">
            This page needs an invite link. Please use the full link your administrator sent you.
          </div>
        ) : done ? (
          <div className="rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-3 text-center">
            Password set. Redirecting to sign in…
          </div>
        ) : (
          <form onSubmit={submit}>
            {error && (
              <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">
                {error}
              </div>
            )}

            <label className="block text-sm font-medium text-gray-700 mb-1">New password</label>
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus
              className="w-full mb-4 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
            />

            <label className="block text-sm font-medium text-gray-700 mb-1">Confirm password</label>
            <input
              type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required
              className="w-full mb-2 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
            <div className="text-xs text-gray-400 mb-5">At least 10 characters.</div>

            <button
              type="submit" disabled={busy}
              className="w-full rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white font-medium py-2 text-sm"
            >
              {busy ? 'Saving…' : 'Set password & continue'}
            </button>
          </form>
        )}

        <div className="mt-4 text-center">
          <Link to="/portal/login" className="text-sm text-teal-700 hover:underline">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}
