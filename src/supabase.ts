import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://ufujcwfakwdtyhbmolyr.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVmdWpjd2Zha3dkdHloYm1vbHlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MjE3OTcsImV4cCI6MjA5ODA5Nzc5N30.sz2hH_Vo-DQRxIsRelZtaIfVzY7ftFb_Qeuieu1nwWo';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing Supabase environment variables! Please check your .env file.');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);



