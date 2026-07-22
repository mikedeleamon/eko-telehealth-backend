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
  // Children before parents — every table referencing users/doctors must be
  // cleared first or the foreign keys block the delete.
  await db.delete(s.messages);
  await db.delete(s.notifications);
  await db.delete(s.agendaItems);
  await db.delete(s.earningsLedger);
  await db.delete(s.prescriptions);
  await db.delete(s.labs);
  await db.delete(s.medicalNotes);
  await db.delete(s.documents);
  await db.delete(s.rosterPatients);
  await db.delete(s.complaints);
  await db.delete(s.promoRedemptions);
  await db.delete(s.payments);
  await db.delete(s.appointments);
  await db.delete(s.conversations);
  await db.delete(s.reviews);
  await db.delete(s.providerApplications);
  await db.delete(s.verificationCodes);
  await db.delete(s.pendingSignups);
  await db.delete(s.dependents);
  await db.delete(s.insuranceInfo);
  await db.delete(s.pharmacyPreferences);
  await db.delete(s.userSettings);
  await db.delete(s.platformSettings);
  await db.delete(s.promoCodes);
  await db.delete(s.currencies);
  await db.delete(s.contentBlocks);
  await db.delete(s.doctors);
  await db.delete(s.users);

  const passwordHash = await hashPassword('Password123!');

  console.log('Seeding users…');
  const insertedUsers = await db
    .insert(s.users)
    .values([
      { firstName: 'Martin', lastName: 'Doe', email: 'martin@ekotelehealth.com', passwordHash, accountType: 'Patient', status: 'active', emailVerified: true },
      { firstName: 'Amara', lastName: 'Okafor', email: 'a.okafor@ekotelehealth.com', passwordHash, accountType: 'Doctor', status: 'active', emailVerified: true },
      { firstName: 'Eko', lastName: 'Admin', email: 'admin@ekotelehealth.com', passwordHash, accountType: 'Admin', status: 'active', emailVerified: true },
      { firstName: 'Ngozi', lastName: 'Nwosu', email: 'ngozi.n@gmail.com', passwordHash, accountType: 'Patient', status: 'active', emailVerified: true },
      { firstName: 'Chinedu', lastName: 'Eze', email: 'c.eze@ekotelehealth.com', passwordHash, accountType: 'Doctor', status: 'active', emailVerified: true },
      { firstName: 'Tunde', lastName: 'Bakare', email: 'tunde.b@yahoo.com', passwordHash, accountType: 'Patient', status: 'suspended', emailVerified: true },
      { firstName: 'Emeka', lastName: 'Obi', email: 'emeka.obi@gmail.com', passwordHash, accountType: 'Patient', status: 'active', emailVerified: true },
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
      { userId: amaraUser.id, name: 'Dr. Amara Okafor MD', specialty: 'Therapist, Primary care doctor', category: 'Primary Care', rating: 4.9, reviews: 79, location: 'Victoria Island, Lagos', fee: '₦15,000', available: true, nextAvailable: '29, June', canProvideInHome: true, spokenLanguages: ['English', 'Igbo'] },
      { userId: chineduUser.id, name: 'Dr. Chinedu Eze MD', specialty: 'Eye Specialist, Eye Doctor', category: 'Eye Doctor', rating: 4.9, reviews: 79, location: 'Ikeja, Lagos', fee: '₦22,000', available: true, nextAvailable: '29, June', spokenLanguages: ['English', 'Yoruba', 'Pidgin'] },
      { name: 'Dr. Funmilayo Adeyemi', specialty: 'OBGYN Specialist', category: 'OBGYN', rating: 4.7, reviews: 213, location: 'Garki, Abuja', fee: '₦28,000', available: false, nextAvailable: '2, July', spokenLanguages: ['English', 'Yoruba'] },
      { name: 'Dr. James Whitfield MD', specialty: 'Cardiologist, Internal Medicine', category: 'Cardiology', rating: 4.6, reviews: 87, location: 'London, UK · Remote', fee: '₦38,000', available: true, nextAvailable: '30, June', spokenLanguages: ['English'] },
      { name: 'Dr. Aisha Bello MD', specialty: 'Dermatologist', category: 'Dermatology', rating: 4.9, reviews: 301, location: 'Port Harcourt, Rivers', fee: '₦20,000', available: true, nextAvailable: '1, July', canProvideInHome: true, spokenLanguages: ['English', 'Hausa', 'Pidgin'] },
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
    // Two rows sit mid-lifecycle so the demo has something to act on: the
    // doctor can Accept/Decline the pending_approval one, and the patient can
    // pay the pending_payment one.
    { patientId: martin.id, doctorId: amara.id, doctorName: amara.name, specialty: 'Primary Care', date: 'Fri, Jul 24, 2026', time: '9:30 AM', type: 'Video Visit', status: 'pending_approval', fee: amara.fee },
    { patientId: martin.id, doctorId: chinedu.id, doctorName: chinedu.name, specialty: 'Eye Doctor', date: 'Thu, Jul 23, 2026', time: '4:00 PM', type: 'Clinic Visit', status: 'pending_payment', fee: chinedu.fee, acceptedAt: hoursAgo(3) },
    { patientId: martin.id, doctorId: amara.id, doctorName: amara.name, specialty: 'Primary Care', date: 'Mon, Jun 29, 2026', time: '10:00 AM', type: 'Video Visit', status: 'upcoming', fee: amara.fee },
    { patientId: martin.id, doctorId: chinedu.id, doctorName: chinedu.name, specialty: 'Eye Doctor', date: 'Wed, Jul 2, 2026', time: '2:30 PM', type: 'Clinic Visit', status: 'upcoming', fee: chinedu.fee },
    { patientId: martin.id, doctorId: funmi.id, doctorName: funmi.name, specialty: 'OBGYN', date: 'May 15, 2026', time: '11:00 AM', type: 'Video Visit', status: 'past', fee: funmi.fee },
    { patientId: martin.id, doctorId: whitfield.id, doctorName: whitfield.name, specialty: 'Cardiology', date: 'Apr 28, 2026', time: '3:00 PM', type: 'Clinic Visit', status: 'past', fee: whitfield.fee },
    // Emeka's request is pending so Dr. Amara's practice queue isn't empty.
    { patientId: emeka.id, doctorId: amara.id, doctorName: amara.name, specialty: 'Primary Care', date: 'Fri, Jul 24, 2026', time: '11:00 AM', type: 'Video Visit', status: 'pending_approval', fee: amara.fee },
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
  const insertedRoster = await db.insert(s.rosterPatients).values([
    // Linked to the real Emeka user below (he has an appointment with Amara),
    // demonstrating the roster↔account link: his prescriptions/labs/notes are
    // seeded under his real user id so they show up in his own self-view too.
    // Ngozi and Tunde below share names with real seeded users but have no
    // appointment with Amara, so — correctly — they stay unlinked.
    { doctorId: amara.id, name: 'Emeka Obi', age: 34, gender: 'Male', condition: 'Hypertension', lastVisit: 'Jun 20, 2026', userId: emeka.id },
    { doctorId: amara.id, name: 'Yusuf Ibrahim', age: 28, gender: 'Male', condition: 'First Visit', lastVisit: 'New patient' },
    { doctorId: amara.id, name: 'Alex Stewart', age: 45, gender: 'Male', condition: 'Diabetes Type 2', lastVisit: 'Jun 12, 2026' },
    { doctorId: amara.id, name: 'Augustine Watts', age: 52, gender: 'Female', condition: 'Migraine', lastVisit: 'Jun 5, 2026' },
    { doctorId: amara.id, name: 'Ngozi Nwosu', age: 31, gender: 'Female', condition: 'Pregnancy care', lastVisit: 'May 29, 2026' },
    { doctorId: amara.id, name: 'Tunde Bakare', age: 40, gender: 'Male', condition: 'Annual checkup', lastVisit: 'May 14, 2026' },
  ]).returning();
  const rosterByName = Object.fromEntries(insertedRoster.map((p) => [p.name, p] as const));
  const alexRoster = rosterByName['Alex Stewart'];
  await db.insert(s.agendaItems).values([
    { doctorId: amara.id, name: 'Emeka Obi', type: 'Consultation', time: '12:30 pm', status: 'confirmed' },
    { doctorId: amara.id, name: 'Yusuf Ibrahim', type: 'First Visit', time: '11:30 am', status: 'cancelled' },
    { doctorId: amara.id, name: 'Bisi Alade', type: 'Consultation', time: '12:30 pm', status: 'rescheduled' },
    { doctorId: amara.id, name: 'Augustine Watts', type: 'Consultation', time: '10:30 am', status: 'pending' },
    { doctorId: amara.id, name: 'Emeka Obi', type: 'Consultation', time: '12:30 pm', status: 'confirmed' },
  ]);

  console.log('Seeding prescriptions…');
  await db.insert(s.prescriptions).values([
    // Martin's own record — powers the patient-facing Prescriptions tab
    // (GET /me/prescriptions, keyed by user id).
    { patientId: martin.id, drug: 'Cetirizine', strength: '10 mg', form: 'Tablet', route: 'Oral', frequency: 'Once daily', duration: 'Ongoing', quantity: '30', refills: '2', instructions: 'Take one tablet daily for seasonal allergies.', status: 'active', doctorId: amara.id, doctorName: amara.name, datePrescribed: 'Jul 4, 2026' },
    { patientId: martin.id, drug: 'Omeprazole', strength: '20 mg', form: 'Capsule', route: 'Oral', frequency: 'Once daily', duration: '28 days', quantity: '28', refills: '1', instructions: 'Take 30 minutes before breakfast.', status: 'active', doctorId: amara.id, doctorName: amara.name, datePrescribed: 'Jun 20, 2026' },
    { patientId: martin.id, drug: 'Amoxicillin', strength: '500 mg', form: 'Capsule', route: 'Oral', frequency: 'Three times daily', duration: '7 days', quantity: '21', refills: '0', instructions: 'Completed course for chest infection.', status: 'completed', doctorId: amara.id, doctorName: amara.name, datePrescribed: 'Mar 12, 2026' },
    // Roster-patient records — power the doctor's Prescription History screen
    // (GET /practice/patients/:rosterId/prescriptions, keyed by roster id).
    { patientId: emeka.id, drug: 'Amlodipine', strength: '10 mg', form: 'Tablet', route: 'Oral', frequency: 'Once daily', duration: 'Ongoing', quantity: '30', refills: '3', instructions: 'Take one tablet in the morning with water.', status: 'active', doctorId: amara.id, doctorName: amara.name, datePrescribed: 'Jun 20, 2026' },
    { patientId: emeka.id, drug: 'Hydrochlorothiazide', strength: '25 mg', form: 'Tablet', route: 'Oral', frequency: 'Once daily', duration: '90 days', quantity: '90', refills: '0', instructions: 'Discontinued — switched to amlodipine due to ankle oedema.', status: 'discontinued', doctorId: amara.id, doctorName: amara.name, datePrescribed: 'Feb 14, 2026' },
    { patientId: alexRoster.id, drug: 'Metformin', strength: '1000 mg', form: 'Tablet', route: 'Oral', frequency: 'Twice daily', duration: 'Ongoing', quantity: '60', refills: '5', instructions: 'Take with breakfast and dinner to reduce GI upset.', status: 'active', doctorId: amara.id, doctorName: amara.name, datePrescribed: 'Jun 12, 2026' },
  ]);

  console.log('Seeding labs…');
  await db.insert(s.labs).values([
    // Martin's own results — power the patient Account → Labs screen (/me/labs).
    { patientId: martin.id, testName: 'Fasting Blood Glucose', loincCode: '1558-6', specimen: 'Serum', value: '5.2', unit: 'mmol/L', referenceRange: '3.9–5.5', flag: 'normal', status: 'resulted', orderedBy: 'Dr. Amara Okafor', performingLab: 'Lagoon Clinical Labs', collectedDate: 'Jul 8, 2026', resultedDate: 'Jul 9, 2026', notes: 'Within normal limits.' },
    { patientId: martin.id, testName: 'Total Cholesterol', loincCode: '2093-3', specimen: 'Serum', value: '6.1', unit: 'mmol/L', referenceRange: '< 5.2', flag: 'high', status: 'resulted', orderedBy: 'Dr. Amara Okafor', performingLab: 'Lagoon Clinical Labs', collectedDate: 'Jul 8, 2026', resultedDate: 'Jul 9, 2026', notes: 'Borderline high — advise dietary review.' },
    { patientId: martin.id, testName: 'Haemoglobin (CBC)', loincCode: '718-7', specimen: 'Whole blood', value: '13.8', unit: 'g/dL', referenceRange: '13.0–17.0', flag: 'normal', status: 'resulted', orderedBy: 'Dr. Amara Okafor', performingLab: 'Lagoon Clinical Labs', collectedDate: 'Mar 2, 2026', resultedDate: 'Mar 3, 2026' },
    // Roster-patient results — power the doctor's PatientProfile → Labs screen.
    { patientId: emeka.id, testName: 'Serum Potassium', loincCode: '2823-3', specimen: 'Serum', value: '5.6', unit: 'mmol/L', referenceRange: '3.5–5.1', flag: 'high', status: 'resulted', orderedBy: 'Dr. Amara Okafor', performingLab: 'St. Nicholas Lab', collectedDate: 'Jun 18, 2026', resultedDate: 'Jun 19, 2026', notes: 'Recheck; review ACE inhibitor dose.' },
    { patientId: alexRoster.id, testName: 'HbA1c', loincCode: '4548-4', specimen: 'Whole blood', value: '8.2', unit: '%', referenceRange: '< 7.0', flag: 'high', status: 'resulted', orderedBy: 'Dr. Amara Okafor', performingLab: 'St. Nicholas Lab', collectedDate: 'Jun 10, 2026', resultedDate: 'Jun 11, 2026', notes: 'Above target — intensify glycaemic control.' },
  ]);

  console.log('Seeding medical notes…');
  await db.insert(s.medicalNotes).values([
    {
      patientId: emeka.id, appointmentId: 'seed-visit-1', date: 'Jun 20, 2026', visitType: 'Video Visit',
      doctorId: amara.id, doctorName: amara.name, doctorSpecialty: amara.specialty,
      reason: 'Hypertension follow-up',
      subjective: 'Reports occasional morning headaches. Adherent to medication.',
      objective: 'BP 148/92 mmHg, HR 78 bpm. No peripheral oedema.',
      assessment: 'Essential hypertension', primaryDiagnosis: 'Essential hypertension',
      secondaryDiagnoses: ['Obesity (BMI 31)'],
      plan: 'Increase amlodipine to 10 mg daily. Recheck BP in 4 weeks.',
      status: 'final',
    },
    {
      patientId: alexRoster.id, appointmentId: 'seed-visit-2', date: 'Jun 12, 2026', visitType: 'Clinic Visit',
      doctorId: amara.id, doctorName: amara.name, doctorSpecialty: amara.specialty,
      reason: 'Diabetes review',
      subjective: 'Fatigue in the afternoons. Home glucose 8–10 mmol/L.',
      objective: 'HbA1c 8.2%. Feet: intact sensation.',
      assessment: 'Type 2 diabetes mellitus, suboptimal control', primaryDiagnosis: 'Type 2 diabetes mellitus, suboptimal control',
      secondaryDiagnoses: [],
      plan: 'Add empagliflozin 10 mg daily. Dietitian referral. Repeat HbA1c in 3 months.',
      status: 'final',
    },
  ]);

  console.log('Seeding currencies…');
  await db.insert(s.currencies).values([
    { code: 'NGN', symbol: '₦', ngnRate: 1, active: true },
    { code: 'USD', symbol: '$', ngnRate: 1600, active: true },
    { code: 'GBP', symbol: '£', ngnRate: 2000, active: true },
    { code: 'EUR', symbol: '€', ngnRate: 1750, active: true },
  ]);

  console.log('Seeding content blocks…');
  await db.insert(s.contentBlocks).values([
    {
      key: 'about_mission',
      title: 'Our Mission',
      body: 'Eko Telehealth connects patients with licensed, verified doctors for video, clinic, and home visits — bringing quality healthcare within reach, wherever you are.',
    },
    {
      key: 'about_contact',
      title: 'Contact Us',
      body: 'Have a question or need help? Reach our support team at support@ekotelehealth.com, or use "Report a Problem" in Settings to file a trackable request.',
    },
    {
      key: 'terms_of_service',
      title: 'Terms of Service',
      body: 'By using Eko Telehealth, you agree to receive care from licensed providers subject to their own professional obligations, to provide accurate information during registration and consultations, and to use the platform only for its intended purpose of arranging and conducting telehealth visits. Eko Telehealth is a marketplace connecting patients and providers; it does not itself practice medicine. Full terms are available on request from support@ekotelehealth.com.',
    },
    {
      key: 'privacy_policy',
      title: 'Privacy Policy',
      body: 'Eko Telehealth collects the information needed to provide care: your account details, appointment history, and any medical information you or your provider add to your record. This information is shared only with providers you consult and is never sold. You can request a copy or deletion of your data at any time via support@ekotelehealth.com.',
    },
  ]);

  console.log('Seeding platform settings + doctor earnings…');
  await db.insert(s.platformSettings).values({ serviceChargePct: 0, commissionPct: 0.175, vatPct: 0.075 });
  // Amara's fee is ₦15,000; at the default 17.5% commission that's a ₦12,375
  // payout per visit — VAT is patient-borne (added on top, task 0.1.d) so,
  // unlike the old client-side split, it's never withheld here.
  await db.insert(s.earningsLedger).values([
    { doctorId: amara.id, kind: 'earning', title: 'Emeka Obi', date: 'Jul 18, 2026', time: '10:00 AM', amount: 12375, status: 'settled' },
    { doctorId: amara.id, kind: 'earning', title: 'Alex Stewart', date: 'Jul 17, 2026', time: '2:30 PM', amount: 12375, status: 'settled' },
    { doctorId: amara.id, kind: 'withdrawal', title: 'Withdrawal', date: 'Jul 16, 2026', time: '9:15 AM', amount: 25000, status: 'settled' },
    { doctorId: amara.id, kind: 'earning', title: 'Ngozi Nwosu', date: 'Jul 15, 2026', time: '11:00 AM', amount: 12375, status: 'settled' },
    { doctorId: amara.id, kind: 'earning', title: 'Augustine Watts', date: 'Jul 12, 2026', time: '3:00 PM', amount: 12375, status: 'settled' },
    { doctorId: amara.id, kind: 'earning', title: 'Emeka Obi', date: 'Jul 8, 2026', time: '10:30 AM', amount: 12375, status: 'settled' },
  ]);

  console.log('Seeding promo codes…');
  await db.insert(s.promoCodes).values([
    { code: 'SAVE20', kind: 'percent', value: 0.2, minSpend: 0, maxRedemptions: null, perUserLimit: 1, active: true },
    { code: 'WELCOME2000', kind: 'flat', value: 2000, minSpend: 10000, maxRedemptions: 50, perUserLimit: 1, active: true },
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
    // Published patient→provider reviews for the seeded live doctor, so the
    // App Store-style reviews page has real data (average + distribution).
    { author: 'Alex F.', subject: 'Dr. Amara Okafor MD', direction: 'patient→provider', rating: 5, title: 'So many words, so little time', text: 'Excellent doctor! Very thorough and caring. Took the time to answer every one of my questions and never made me feel rushed. The follow-up notes were detailed and easy to understand.', verified: true, commentsCount: 100, submittedAt: 'Apr 16, 2026', status: 'published' },
    { author: 'Alex S.', subject: 'Dr. Amara Okafor MD', direction: 'patient→provider', rating: 5, title: 'Excellent work', text: 'Great experience overall. Short wait time and the video call was crystal clear. Prescriptions were sent to my pharmacy within the hour.', verified: true, commentsCount: 10, submittedAt: 'Jan 28, 2026', status: 'published' },
    { author: 'Sam S.', subject: 'Dr. Amara Okafor MD', direction: 'patient→provider', rating: 5, title: 'So many words', text: 'Highly recommend! Very knowledgeable and professional. Explained my diagnosis clearly and laid out every option before we decided on a plan together.', verified: true, commentsCount: 80, submittedAt: 'Jan 16, 2026', status: 'published' },
    { author: 'Ada O.', subject: 'Dr. Amara Okafor MD', direction: 'patient→provider', rating: 4, title: 'Really helpful', text: 'Solid consultation and genuinely helpful advice. Knocked a star off only because the app kept me waiting a couple of minutes past my slot.', verified: true, commentsCount: 4, submittedAt: 'Dec 30, 2025', status: 'published' },
    { author: 'Tunde A.', subject: 'Dr. Amara Okafor MD', direction: 'patient→provider', rating: 4, title: 'Would book again', text: 'Professional and friendly. Answered my follow-up message the same day.', verified: true, commentsCount: 2, submittedAt: 'Dec 12, 2025', status: 'published' },
    { author: 'Ngozi E.', subject: 'Dr. Amara Okafor MD', direction: 'patient→provider', rating: 3, title: 'Decent but rushed', text: 'The advice was fine but the call felt a little rushed towards the end.', verified: false, commentsCount: 1, submittedAt: 'Nov 20, 2025', status: 'published' },
  ]);

  console.log('Seeding complaints…');
  await db.insert(s.complaints).values([
    {
      userId: martin.id,
      authorName: `${martin.firstName} ${martin.lastName}`,
      accountType: 'Patient',
      category: 'billing',
      subject: 'Charged twice for the same visit',
      description: 'I was charged twice on my card for my July 18 video visit with Dr. Okafor. Please refund the duplicate charge.',
      submittedAt: 'Jul 19, 2026',
      status: 'pending',
    },
    {
      userId: martin.id,
      authorName: `${martin.firstName} ${martin.lastName}`,
      accountType: 'Patient',
      category: 'technical',
      subject: 'Video call kept freezing',
      description: 'The video kept freezing every couple of minutes during my consultation and we had to finish over audio only.',
      submittedAt: 'Jul 10, 2026',
      status: 'resolved',
      resolutionNote: 'Traced to a CDN region issue on our video provider\'s side, resolved as of Jul 12. Sorry for the disruption — let us know if it happens again.',
      resolvedAt: new Date('2026-07-12T15:00:00Z'),
    },
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
