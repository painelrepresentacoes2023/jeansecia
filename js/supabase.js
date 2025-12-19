import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

export const SUPABASE_URL = "https://bstuweeozogflqzywbwo.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJzdHV3ZWVvem9nZmxxenl3YndvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxMzQxNjIsImV4cCI6MjA4MTcxMDE2Mn0.KNx7e0YsVHaoQRQXgopL6wEC3CliF03-rA8jsp7-WaU";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
