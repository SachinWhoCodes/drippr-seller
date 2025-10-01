import DashboardLayout from "@/components/DashboardLayout";
import StatsCard from "@/components/StatsCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DollarSign, Package, ShoppingCart, TrendingUp } from "lucide-react";
import { mockOrders } from "@/lib/mockData";
import { Badge } from "@/components/ui/badge";

export default function Dashboard() {
  const getStatusColor = (status: string) => {
    switch (status) {
      case "delivered":
        return "bg-success/10 text-success border-success/20";
      case "shipped":
        return "bg-primary/10 text-primary border-primary/20";
      case "pending":
        return "bg-warning/10 text-warning border-warning/20";
      case "cancelled":
        return "bg-destructive/10 text-destructive border-destructive/20";
      default:
        return "";
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Dashboard Overview</h2>
          <p className="text-muted-foreground">Track your sales and manage your store</p>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatsCard
            title="Total Sales"
            value="₹1,24,550"
            change="+12.5% from last month"
            changeType="positive"
            icon={DollarSign}
            iconColor="text-success"
          />
          <StatsCard
            title="Orders Pending"
            value="23"
            change="5 urgent"
            changeType="neutral"
            icon={ShoppingCart}
            iconColor="text-warning"
          />
          <StatsCard
            title="Monthly Earnings"
            value="₹45,231"
            change="+8.2% from last month"
            changeType="positive"
            icon={TrendingUp}
            iconColor="text-primary"
          />
          <StatsCard
            title="Active Products"
            value="156"
            change="12 low stock"
            changeType="neutral"
            icon={Package}
            iconColor="text-accent"
          />
        </div>

        {/* Recent Orders */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Orders</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {mockOrders.slice(0, 5).map((order) => (
                <div
                  key={order.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg border bg-card hover:bg-accent/5 transition-colors"
                >
                  <div className="space-y-1 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold">{order.id}</p>
                      <Badge className={getStatusColor(order.status)}>
                        {order.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{order.customer}</p>
                    <p className="text-sm">{order.products}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="font-semibold">₹{order.amount.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">{order.date}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
