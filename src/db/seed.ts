/**
 * Seed the database with the same Nigeria-flavored demo data the apps used in
 * mock mode, so every screen works immediately against the real backend.
 *
 * Run once after `npm run db:push`:  npm run db:seed
 * Idempotent: it clears the tables first, so it's safe to re-run.
 *
 * Demo logins (all use password: Password123!)
 *   Patient  martin@ekotelehealth.com
 *   Doctor   a.okafor@ekotelehealth.com
 *   Admin    admin@ekotelehealth.com
 */
import 'dotenv/config';
import { closeDb, getDb } from './client';
import * as s from './schema';
import { hashPassword } from '../lib/password';

const now = Date.now();
const daysAgo = (n: number) => new Date(now - n * 86_400_000);
const hoursAgo = (n: number) => new Date(now - n * 3_600_000);
const minsAgo = (n: number) => new Date(now - n * 60_000);

async function seed() {
  const db = getDb();

  console.log('Clearing existing data…');
  await db.delete(s.messages);
  await db.delete(s.notifications);
  await db.delete(s.agendaItems);
  await db.delete(s.rosterPatients);
  await db.delete(s.payments);
  await db.delete(s.appointments);
  await db.delete(s.conversations);
  await db.delete(s.reviews);
  await db.delete(s.providerApplications);
  await db.delete(s.verificationCodes);
  await db.delete(s.doctors);
  await db.delete(s.users);

  const passwordHash = await hashPassword('Password123!');

  console.log('Seeding users…');
  const insertedUsers = await db
    .insert(s.users)
    .values([
      { firstName: 'Martin', lastName: 'Doe', email: 'martin@ekotelehealth.com', passwordHash, role: 'Patient', status: 'active' },
      { firstName: 'Amara', lastName: 'Okafor', email: 'a.okafor@ekotelehealth.com', passwordHash, role: 'Doctor', status: 'active' },
      { firstName: 'Eko', lastName: 'Admin', email: 'admin@ekotelehealth.com', passwordHash, role: 'Admin', status: 'active' },
      { firstName: 'Ngozi', lastName: 'Nwosu', email: 'ngozi.n@gmail.com', passwordHash, role: 'Patient', status: 'active' },
      { firstName: 'Chinedu', lastName: 'Eze', email: 'c.eze@ekotelehealth.com', passwordHash, role: 'Doctor', status: 'active' },
      { firstName: 'Tunde', lastName: 'Bakare', email: 'tunde.b@yahoo.com', passwordHash, role: 'Patient', status: 'suspended' },
      { firstName: 'Emeka', lastName: 'Obi', email: 'emeka.obi@gmail.com', passwordHash, role: 'Patient', status: 'active' },
    ])
    .returning();
  const userByEmail = Object.fromEntries(insertedUsers.map((u) => [u.email, u] as const));
  const martin = userByEmail['martin@ekotelehealth.com'];
  const amaraUser = userByEmail['a.okafor@ekotelehealth.com'];
  const chineduUser = userByEmail['c.eze@ekotelehealth.com'];
  const ngozi = userByEmail['ngozi.n@gmail.com'];
  const emeka = userByEmail['emeka.obi@gmail.com'];

  console.log('Seeding doctors…');
  const insertedDoctors = await db
    .insert(s.doctors)
    .values([
      { userId: amaraUser.id, name: 'Dr. Amara Okafor MD', specialty: 'Therapist, Primary care doctor', category: 'Primary Care', rating: 4.9, reviews: 79, location: 'Victoria Island, Lagos', fee: '₦15,000', available: true, nextAvailable: '29, June' },
      { userId: chineduUser.id, name: 'Dr. Chinedu Eze MD', specialty: 'Eye Specialist, Eye Doctor', category: 'Eye Doctor', rating: 4.9, reviews: 79, location: 'Ikeja, Lagos', fee: '₦22,000', available: true, nextAvailable: '29, June' },
      { name: 'Dr. Funmilayo Adeyemi', specialty: 'OBGYN Specialist', category: 'OBGYN', rating: 4.7, reviews: 213, location: 'Garki, Abuja', fee: '₦28,000', available: false, nextAvailable: '2, July' },
      { name: 'Dr. James Whitfield MD', specialty: 'Cardiologist, Internal Medicine', category: 'Cardiology', rating: 4.6, reviews: 87, location: 'London, UK · Remote', fee: '₦38,000', available: true, nextAvailable: '30, June' },
      { name: 'Dr. Aisha Bello MD', specialty: 'Dermatologist', category: 'Dermatology', rating: 4.9, reviews: 301, location: 'Port Harcourt, Rivers', fee: '₦20,000', available: true, nextAvailable: '1, July' },
    ])
    .returning();
  const docByName = Object.fromEntries(insertedDoctors.map((d) => [d.name, d] as const));
  const amara = docByName['Dr. Amara Okafor MD'];
  const chinedu = docByName['Dr. Chinedu Eze MD'];
  const funmi = docByName['Dr. Funmilayo Adeyemi'];
  const whitfield = docByName['Dr. James Whitfield MD'];
  const aisha = docByName['Dr. Aisha Bello MD'];

  console.log('Seeding appointments…');
  await db.insert(s.appointments).values([
    { patientId: martin.id, doctorId: amara.id, doctorName: amara.name, specialty: 'Primary Care', date: 'Mon, Jun 29, 2026', time: '10:00 AM', type: 'Video Visit', status: 'upcoming', fee: amara.fee },
    { patientId: martin.id, doctorId: chinedu.id, doctorName: chinedu.name, specialty: 'Eye Doctor', date: 'Wed, Jul 2, 2026', time: '2:30 PM', type: 'Clinic Visit', status: 'upcoming', fee: chinedu.fee },
    { patientId: martin.id, doctorId: funmi.id, doctorName: funmi.name, specialty: 'OBGYN', date: 'May 15, 2026', time: '11:00 AM', type: 'Video Visit', status: 'past', fee: funmi.fee },
    { patientId: martin.id, doctorId: whitfield.id, doctorName: whitfield.name, specialty: 'Cardiology', date: 'Apr 28, 2026', time: '3:00 PM', type: 'Clinic Visit', status: 'past', fee: whitfield.fee },
    { patientId: emeka.id, doctorId: chinedu.id, doctorName: chinedu.name, specialty: 'Eye Doctor', date: 'Mon, Jul 6, 2026', time: '2:30 PM', type: 'Clinic Visit', status: 'upcoming', fee: chinedu.fee },
    { patientId: ngozi.id, doctorId: funmi.id, doctorName: funmi.name, specialty: 'OBGYN', date: 'Jul 5, 2026', time: '11:00 AM', type: 'Video Visit', status: 'past', fee: funmi.fee },
  ]);

  console.log('Seeding conversations + messages…');
  const insertedConvos = await db
    .insert(s.conversations)
    .values([
      { patientId: martin.id, doctorId: amara.id, lastMessage: "Thank you, I'll review your information shortly.", unread: 2, updatedAt: daysAgo(0) },
      { patientId: martin.id, doctorId: chinedu.id, lastMessage: 'Your prescription is ready for pickup.', unread: 0, updatedAt: daysAgo(1) },
      { patientId: martin.id, doctorId: whitfield.id, lastMessage: 'Let me know if the symptoms persist.', unread: 0, updatedAt: daysAgo(3) },
      { patientId: martin.id, doctorId: aisha.id, lastMessage: 'See you at your next appointment!', unread: 1, updatedAt: daysAgo(26) },
    ])
    .returning();
  const c1 = insertedConvos[0];
  await db.insert(s.messages).values([
    { conversationId: c1.id, senderId: amaraUser.id, text: 'Hello! How can I help you today?', createdAt: minsAgo(240) },
    { conversationId: c1.id, senderId: martin.id, text: "Hi doctor, I've been having some headaches lately.", createdAt: minsAgo(239) },
    { conversationId: c1.id, senderId: amaraUser.id, text: 'I see. How long have you been experiencing them? Are they accompanied by any other symptoms?', createdAt: minsAgo(238) },
    { conversationId: c1.id, senderId: martin.id, text: 'About a week. I also feel a bit dizzy sometimes.', createdAt: minsAgo(237) },
  ]);

  console.log('Seeding notifications…');
  await db.insert(s.notifications).values([
    { userId: martin.id, title: 'Appointment Reminder', body: 'Your appointment with Dr. Amara Okafor is tomorrow at 10:00 AM.', createdAt: hoursAgo(2) },
    { userId: martin.id, title: 'Appointment Confirmed', body: 'Dr. Chinedu Eze confirmed your Jul 2 appointment.', createdAt: hoursAgo(24) },
    { userId: martin.id, title: 'New Message', body: 'You have a new message from Dr. Funmilayo Adeyemi.', createdAt: hoursAgo(48) },
    { userId: martin.id, title: 'Payment Successful', body: 'Your payment of ₦15,000 for the video visit has been processed.', createdAt: hoursAgo(72) },
  ]);

  console.log('Seeding doctor roster + agenda…');
  await db.insert(s.rosterPatients).values([
    { doctorId: amara.id, name: 'Emeka Obi', age: 34, gender: 'Male', condition: 'Hypertension', lastVisit: 'Jun 20, 2026' },
    { doctorId: amara.id, name: 'Yusuf Ibrahim', age: 28, gender: 'Male', condition: 'First Visit', lastVisit: 'New patient' },
    { doctorId: amara.id, name: 'Alex Stewart', age: 45, gender: 'Male', condition: 'Diabetes Type 2', lastVisit: 'Jun 12, 2026' },
    { doctorId: amara.id, name: 'Augustine Watts', age: 52, gender: 'Female', condition: 'Migraine', lastVisit: 'Jun 5, 2026' },
    { doctorId: amara.id, name: 'Ngozi Nwosu', age: 31, gender: 'Female', condition: 'Pregnancy care', lastVisit: 'May 29, 2026' },
    { doctorId: amara.id, name: 'Tunde Bakare', age: 40, gender: 'Male', condition: 'Annual checkup', lastVisit: 'May 14, 2026' },
  ]);
  await db.insert(s.agendaItems).values([
    { doctorId: amara.id, name: 'Emeka Obi', type: 'Consultation', time: '12:30 pm', status: 'confirmed' },
    { doctorId: amara.id, name: 'Yusuf Ibrahim', type: 'First Visit', time: '11:30 am', status: 'cancelled' },
    { doctorId: amara.id, name: 'Bisi Alade', type: 'Consultation', time: '12:30 pm', status: 'rescheduled' },
    { doctorId: amara.id, name: 'Augustine Watts', type: 'Consultation', time: '10:30 am', status: 'pending' },
    { doctorId: amara.id, name: 'Emeka Obi', type: 'Consultation', time: '12:30 pm', status: 'confirmed' },
  ]);

  console.log('Seeding admin queues…');
  await db.insert(s.providerApplications).values([
    { name: 'Dr. Kelechi Umeh', type: 'Doctor', specialty: 'Pediatrics', location: 'Lekki, Lagos', submittedAt: 'Jul 3, 2026', checkGovId: true, checkEmail: true, checkPhone: true, status: 'pending' },
    { name: 'GreenCross Pharmacy', type: 'Pharmacy', specialty: 'Retail pharmacy · delivery', location: 'Surulere, Lagos', submittedAt: 'Jul 2, 2026', checkGovId: true, checkEmail: true, checkPhone: false, status: 'pending' },
    { name: 'Nurse Adaeze Okoro', type: 'Nurse', specialty: 'Home care', location: 'Enugu', submittedAt: 'Jul 1, 2026', checkGovId: false, checkEmail: true, checkPhone: true, status: 'pending' },
    { name: 'Dr. Priya Nair', type: 'Doctor', specialty: 'Endocrinology (international)', location: 'Dubai, UAE · Remote', submittedAt: 'Jun 30, 2026', checkGovId: true, checkEmail: true, checkPhone: true, status: 'pending' },
  ]);
  await db.insert(s.reviews).values([
    { author: 'Martin D.', subject: 'Dr. Amara Okafor', direction: 'patient→provider', rating: 5, text: 'Very attentive and explained everything clearly. The video visit saved me a full day of travel.', submittedAt: 'Jul 4, 2026', status: 'pending' },
    { author: 'Dr. Chinedu Eze', subject: 'Yusuf I.', direction: 'provider→patient', rating: 4, text: 'Punctual and provided complete history ahead of the consultation.', submittedAt: 'Jul 3, 2026', status: 'pending' },
    { author: 'Ngozi N.', subject: 'Dr. James Whitfield', direction: 'patient→provider', rating: 2, text: 'Call started 25 minutes late and was cut short. Contact me at 0803-XXX-XXXX to discuss.', submittedAt: 'Jul 2, 2026', status: 'pending' },
  ]);

  console.log('\nSeed complete. Demo logins (password: Password123!):');
  console.log('  Patient  martin@ekotelehealth.com');
  console.log('  Doctor   a.okafor@ekotelehealth.com');
  console.log('  Admin    admin@ekotelehealth.com');
}

seed()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Seed failed:', err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
