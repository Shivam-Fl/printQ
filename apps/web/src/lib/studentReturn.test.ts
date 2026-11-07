import { describe, expect, it } from 'vitest';
import { studentLoginPath, studentReturnPath } from './studentReturn.js';

describe('studentReturnPath', () => {
  it('returns the student to the page they came from', () => {
    expect(studentReturnPath('/jobs')).toBe('/jobs');
    expect(studentReturnPath('/jobs/abc123')).toBe('/jobs/abc123');
    expect(studentReturnPath('/s/sharma-xerox')).toBe('/s/sharma-xerox');
    expect(studentReturnPath('/s/sharma-xerox/file/f1?x=1#top')).toBe('/s/sharma-xerox/file/f1?x=1#top');
  });

  it('falls back to /home when nothing usable was given', () => {
    expect(studentReturnPath(null)).toBe('/home');
    expect(studentReturnPath(undefined)).toBe('/home');
    expect(studentReturnPath('')).toBe('/home');
    expect(studentReturnPath(42)).toBe('/home');
    expect(studentReturnPath('/')).toBe('/home');
  });

  it('never leaves the site', () => {
    expect(studentReturnPath('https://evil.example/x')).toBe('/home');
    expect(studentReturnPath('//evil.example/x')).toBe('/home');
    expect(studentReturnPath('/\\evil.example')).toBe('/home');
    expect(studentReturnPath('/\t/evil.example')).toBe('/home');
    expect(studentReturnPath('javascript:alert(1)')).toBe('/home');
    expect(studentReturnPath('jobs')).toBe('/home');
  });

  it('does not loop back to /login', () => {
    expect(studentReturnPath('/login')).toBe('/home');
    expect(studentReturnPath('/login?next=/jobs')).toBe('/home');
    expect(studentReturnPath('/login/')).toBe('/home');
    expect(studentReturnPath('/logins-help')).toBe('/logins-help');
  });
});

describe('studentLoginPath', () => {
  it('sends the student to /login with the page to come back to', () => {
    expect(studentLoginPath('/jobs/abc123')).toBe('/login?next=%2Fjobs%2Fabc123');
    expect(studentLoginPath('/profile')).toBe('/login?next=%2Fprofile');
    expect(studentReturnPath(decodeURIComponent(studentLoginPath('/jobs?tab=done').split('next=')[1]!))).toBe('/jobs?tab=done');
  });

  it('keeps plain /login when the page is home anyway', () => {
    expect(studentLoginPath('/home')).toBe('/login');
    expect(studentLoginPath('/')).toBe('/login');
    expect(studentLoginPath('/login?next=%2Fjobs')).toBe('/login?next=%2Fjobs');
  });
});
