import axios from 'axios';

// Axios instance for the standalone product portal. Unlike the MSP app's api.js
// (which acquires MSAL/Entra tokens), the portal authenticates with its own
// email+password JWT, stored in localStorage and sent as a Bearer token.

export const PORTAL_TOKEN_KEY = 'portal_token';

const portalApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api/portal` : '/api/portal',
});

portalApi.interceptors.request.use((config) => {
  const token = localStorage.getItem(PORTAL_TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

portalApi.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem(PORTAL_TOKEN_KEY);
      if (!window.location.pathname.startsWith('/portal/login')) {
        window.location.assign('/portal/login');
      }
    }
    return Promise.reject(error);
  },
);

export default portalApi;
