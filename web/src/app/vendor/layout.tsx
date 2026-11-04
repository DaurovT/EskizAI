import type { Metadata } from 'next';
import '../admin/admin.css';
import './vendor.css';
import { VendorShell } from '@/components/vendor/VendorShell';

export const metadata: Metadata = {
  title: 'Кабинет поставщика · Eskiz AI',
  robots: { index: false, follow: false },
};

export default function VendorLayout({ children }: { children: React.ReactNode }) {
  return <VendorShell>{children}</VendorShell>;
}
