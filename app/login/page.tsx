'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import LockIcon from '@mui/icons-material/Lock';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Could not sign in.');
        setPassword('');
        return;
      }

      const next = searchParams.get('next');
      // Only follow same-site relative paths.
      const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
      router.replace(target);
      router.refresh();
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
      }}
    >
      <Card variant="outlined" sx={{ width: '100%', maxWidth: 400 }}>
        <CardContent sx={{ p: 4 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mb: 3 }}>
            <LockIcon color="primary" sx={{ fontSize: 40, mb: 1 }} />
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              Soccer CRM
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Enter the password to continue
            </Typography>
          </Box>

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          <form onSubmit={handleSubmit}>
            <TextField
              label="Password"
              type="password"
              fullWidth
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
            <Button
              type="submit"
              variant="contained"
              fullWidth
              size="large"
              sx={{ mt: 2 }}
              disabled={submitting || !password}
            >
              {submitting ? 'Checking…' : 'Unlock'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
