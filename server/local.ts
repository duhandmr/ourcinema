import { app, initializeServer } from './index.ts';

const PORT = Number(process.env.PORT) || 3001;

void initializeServer().finally(() => {
    app.listen(PORT, () => {
        console.log(`OurCinema API çalışıyor: http://localhost:${PORT}`);
    });
});
