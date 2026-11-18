# MindQuest — Student App (Android)

Android app para sa **mga student lang** ng MindQuest. Ginawa sa React Native + Expo (SDK 58) + Expo Router, JavaScript.
Iisa ang database at iisa ang mga patakaran ng app at ng website: ang app ay tumatawag sa `/api/mobile` ng mismong MindQuest server.

- Admin, assistant admin at tutor: tinatanggihan sa login at sa bawat request — *"The MindQuest app is for students only. Please use the website."*
- Ang Register at Forgot password ay nasa website pa rin (may link sa Login screen).

---

## 1. Ang kailangan

- Node.js 20 o mas bago
- Android phone na may **Expo Go** (pinakabagong bersyon sa Play Store — dapat suportado ang SDK 58)
- Para sa APK: libreng account sa [expo.dev](https://expo.dev) (EAS Build)
- Sa server (Render): naka-set ang **`MOBILE_TOKEN_SECRET`** (tingnan ang `DEPLOYMENT.md` sa root ng repo)

```bash
cd mindquest-mobile
npm install
```

## 2. Itakda kung saang server kakausap ang app (`apiUrl`)

Nasa `app.json`:

```json
"extra": {
  "apiUrl": "https://mindquesttutorial.com"
}
```

- **Live site** — iwan sa `https://mindquesttutorial.com` (**walang** `www.`). Ito ang dapat sa APK. Ang `www.` ay nire-redirect sa address na walang www, at sa redirect na iyon tinatanggal ng Android ang token — kaya laging mala-logout ang app.
- **Sariling PC** — gamitin ang **LAN IP** ng PC, hindi `localhost`. Sa phone, ang `localhost` ay ang phone mismo, hindi ang PC.
  1. Sa PC, alamin ang IP: `ipconfig` → *IPv4 Address* (hal. `192.168.1.23`).
  2. `"apiUrl": "http://192.168.1.23:3000"` (dapat nasa iisang Wi-Fi ang phone at PC).
  3. Payagan ang port 3000 sa Windows Firewall kung hindi makakonek.

> ⚠️ **Mag-ingat:** ang `.env` ng server ay nakaturo sa **live database**. Kapag pinatakbo mo ang server sa PC (`npm start`), totoong data ang mababago at magpapadala ito ng payment reminders. Para sa pagsubok, gumamit ng hiwalay na test database, o ituro na lang ang app sa live site gamit ang test student account.

> Ang `http://` ay pinapayagan **lang habang nagde-develop** (Expo Go). Sa APK, HTTPS lang ang tatanggapin ng app (`src/lib/config.js`).

## 3. Patakbuhin sa Expo Go

```bash
npx expo start
```

I-scan ang QR code gamit ang Expo Go sa phone. Kung hindi makakonek ang phone sa PC: `npx expo start --tunnel`.

## 4. Gumawa ng APK (EAS Build)

```bash
npx eas-cli@latest login
npx eas-cli@latest build --platform android --profile preview      # APK, para i-install sa phone
npx eas-cli@latest build --platform android --profile production   # AAB, para sa Google Play
```

Sa unang build, tatanungin ka kung gagawa ng *Android keystore* — piliin ang **Yes** (si EAS ang magtatago nito).
Pagkatapos ng build, may link at QR code para i-download ang APK. (Nasa `eas.json` ang dalawang profile.)

Bago mag-build ng bagong bersyon: taasan ang `version` at `android.versionCode` sa `app.json`.

## 5. Paano magdagdag ng bagong screen

**Ang patakaran:** ang path ng screen sa app = ang path ng website ng student, wala lang ang `/student`.
Ang app screen na `/subjects/5` ay tumatawag sa `GET /api/mobile/student/subjects/5`, at ang server ay pinapatakbo ang **mismong route ng website** (`routes/student.js`). Kaya walang bagong business logic sa app.

Halimbawa: may bagong page sa website na `/student/certificates` na nagre-render ng `contentView: '../content/student-certificates'`.

1. **Server — serializer.** Sa `lib/mobileSerializers.js`, magdagdag sa `SERIALIZERS`:
   ```js
   'student-certificates'(locals) {
     return {
       certificates: list(locals.certificates).map((c) => ({ id: num(c.id), title: str(c.title) }))
     };
   },
   ```
   *Whitelist lang* — ilista lang ang mga field na ipinapakita ng website. Huwag ipasa ang `locals` nang buo (may password hash at answer key doon).
2. **App — screen.** Gumawa ng `src/app/certificates.js`:
   ```js
   import { usePage } from '../lib/usePage';
   import { Card, PageView, Body } from '../components/ui';

   export default function CertificatesScreen() {
     const page = usePage('/certificates');
     const d = page.data || {};
     return (
       <PageView page={page}>
         <Card title="Certificates">
           {(d.certificates || []).map((c) => <Body key={c.id}>{c.title}</Body>)}
         </Card>
       </PageView>
     );
   }
   ```
   May loading, error + Retry, pull-to-refresh at flash message na agad dahil sa `usePage` + `PageView`.
3. **Ipaalam sa navigation.** Sa `src/lib/navigation.js`, idagdag ang `/^\/certificates$/` sa `SCREENS`.
4. **I-register sa stack.** Sa `src/app/_layout.js`, sa loob ng `<Stack.Protected guard={signedIn}>`:
   `<Stack.Screen name="certificates" options={{ title: 'Certificates' }} />`
5. **Suriin:** `npx eslint src` at `npx expo export --platform android`. Sa server: `npm test`.

## 6. Ayos ng mga file

```
src/app/                 mga screen (Expo Router: bawat file = isang screen)
  _layout.js             login state + Stack.Protected (logged out: Login lang)
  login.js, verify-otp.js
  (tabs)/                Home, Subjects, Progress, Billing, Profile (+ notification bell)
  subjects/[id]/         subject, Pre-Assessment, Post-Assessment
  modules/, level-modules/, path-modules/[id]/, tutor-assessments/, results/
  billing/slip.js, notifications/, tutors/[id].js
src/components/          ui.js (Card, Button…), TakeAssessment, ResultView, ModuleView, LessonText
src/lib/
  api.js                 lahat ng tawag sa server (token, 90s timeout, 401 → logout, protected files)
  auth.js, session.js    login / OTP / logout; token sa expo-secure-store
  usePage.js             load ng page + reload tuwing bumabalik sa screen
  navigation.js          sundin ang { redirect } / { external } ng server
  format.js              petsa (Asia/Manila, "Nov 07, 2026") at pera ("₱1,234.50")
```

## 7. Seguridad (para sa defense)

- **Token, hindi cookie.** HMAC-SHA256 na pinirmahan ng server (`MOBILE_TOKEN_SECRET`). Ang "pending" token (15 minuto) ay para lang sa OTP; ang "access" token (30 araw) ay nakatali sa trusted phone, kaya ang **Log out** ay talagang pumapatay dito.
- **Bawat request**, binabasa ulit ng server ang student: archived, hindi na student, o hindi approved → tinatanggihan agad.
- **Bagong phone = OTP** sa email (iisang 5-codes-per-hour na limit ng website). Ang na-verify nang phone ay hindi na hihingan.
- **Token sa expo-secure-store** (Android Keystore), hindi sa plain storage.
- **Walang answer key** habang sumasagot; ang tamang sagot ay lumalabas lang sa result, sa mga item na mali — gaya ng website.
- **Anti-cheat:** bawal ang screenshot/screen recording habang may assessment; ang pag-alis sa app ay ipinapadala sa server, at **ang server ang nagbibilang**; sa limit, kusang isinusumite.
- **Handouts at PDF** ay dina-download kasama ang token, at dumadaan sa **parehong** Pre-Assessment lock ng website.
- **Permissions:** photo library lang (para sa profile photo). Walang camera, walang microphone.
- **HTTPS lang** sa APK.
