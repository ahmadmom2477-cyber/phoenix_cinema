import { Router, type IRouter } from "express";
import healthRouter from "./health";
import searchRouter from "./search";
import proxyRouter from "./proxy";
import downloadsRouter from "./downloads";
import subtitlesRouter from "./subtitles";
import genresRouter from "./genres";
import subscriptionRouter from "./subscription";
import accessRouter from "./access";
import adminRouter from "./admin";
import torrentStreamRouter from "./torrent-stream";
import torrentInfoRouter from "./torrent-info";
import torrentFileRouter from "./torrent-file";
import player5Router from "./player5";

const router: IRouter = Router();

router.use(healthRouter);
router.use(searchRouter);
router.use(proxyRouter);
router.use(downloadsRouter);
router.use(subtitlesRouter);
router.use(genresRouter);
router.use(subscriptionRouter);
router.use(accessRouter);
router.use(adminRouter);
router.use(torrentStreamRouter);
router.use(torrentInfoRouter);
router.use(torrentFileRouter);
router.use(player5Router);

export default router;
