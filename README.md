# **Run and deploy your AI Studio app**

This contains everything you need to run your app locally.

## **Run Locally**

**Prerequisites:** Node.js, Firebase CLI

1. **Install dependencies:**  
   npm install  
   cd functions && npm install && cd ..

2. **Set up Environment Variables:**  
   * Frontend (Root Directory):  
     Create a .env file in the root directory (/):  
     VITE\_FIREBASE\_API\_KEY=your\_firebase\_api\_key  
     VITE\_FIREBASE\_AUTH\_DOMAIN=your\_project.firebaseapp.com  
     VITE\_FIREBASE\_PROJECT\_ID=your\_project\_id  
     VITE\_FIREBASE\_STORAGE\_BUCKET=your\_project.firebasestorage.app  
     VITE\_FIREBASE\_MESSAGING\_SENDER\_ID=your\_sender\_id  
     VITE\_FIREBASE\_APP\_ID=your\_app\_id

   * Backend (Functions Directory):  
     Create a .env file in the functions/ directory:  
     GEMINI\_API\_KEY=your\_api\_key\_here

3. **Run the app:**  
   npm run dev

4. Run Firebase Functions (for AI Proxy):  
   In a separate terminal:  
   npm run emulators

   *(Note: Ensure you have the Firebase emulators installed via firebase init emulators)*

## **Deployment**

1. **Build the app:**  
   npm run build

2. **Deploy to Firebase:**  
   firebase deploy  
